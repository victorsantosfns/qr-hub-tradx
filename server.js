require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

/* ══════════════════════════════════════════════════════════════════════
   QR HUB TRADX — serviço público de redirecionamento (11/09/2026)
   ══════════════════════════════════════════════════════════════════════
   Por que este serviço existe: o HUB TRADX roda em `hub-tradx.ferreiracosta
   .corp`, um domínio INTERNO — nenhum celular fora da rede/VPN da empresa
   consegue resolvê-lo. QR code físico precisa ser lido por qualquer celular,
   de qualquer rede, então o link impresso não pode apontar pro HUB direto.

   Este serviço é o único pedaço público de toda a plataforma: só sabe fazer
   duas coisas (redirecionar um /q/<codigo> pro link de destino, e registrar
   que a leitura aconteceu). Nunca fala com o Oracle, nunca vê senha de
   ninguém, nunca expõe nada do resto do HUB. O HUB TRADX (interno) é sempre
   a fonte da verdade: ele EMPURRA a lista de QR codes pra cá (POST
   /api/sync-qrcodes) sempre que algo muda, e PUXA as leituras daqui de
   tempos em tempos (GET /api/leituras) — mesmo padrão já usado com sucesso
   pelo sistema de Bordados (github.com/victorsantosfns/bordados-atendimentos
   + Render), só que ao contrário (lá o HUB só puxa; aqui puxa E empurra).

   Variáveis de ambiente (configurar no painel do Render):
   - DATABASE_URL   → injetada automaticamente se você criar um banco
                       Postgres no Render e conectar a este serviço.
   - SYNC_SECRET    → uma senha longa qualquer, inventada por você. Tem que
                       ser IDÊNTICA à variável QR_SYNC_SECRET configurada no
                       HUB TRADX (Secret do Kubernetes) — sem isso combinado
                       dos dois lados, a sincronização não funciona.
   ══════════════════════════════════════════════════════════════════════ */

const app = express();
const PORT = process.env.PORT || 3000;
const SYNC_SECRET = process.env.SYNC_SECRET;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qrcodes (
      codigo TEXT PRIMARY KEY,
      link_destino TEXT,
      ativo BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  // 22/09/2026, pedido do Victor: dá pra criar o QR (e já imprimir) antes de
  // ter o link final — cobre quem já tinha o serviço no ar antes dessa
  // mudança (CREATE TABLE IF NOT EXISTS não altera tabela já existente).
  await pool.query(`ALTER TABLE qrcodes ALTER COLUMN link_destino DROP NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leituras (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL,
      lido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip TEXT,
      user_agent TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leituras_id ON leituras (id)`);
  // 22/09/2026, pedido do Victor: indicadores por região/dispositivo — a
  // localização é resolvida pelo IP de quem está lendo NA HORA (rede
  // móvel/wifi do local real), não por nenhum cadastro do aparelho. Ex. do
  // próprio Victor: celular comprado/registrado nos EUA, mas a pessoa está
  // em Recife lendo o QR — tem que aparecer Recife, porque é o IP de rede
  // que importa, não o país de origem do aparelho.
  await pool.query(`ALTER TABLE leituras ADD COLUMN IF NOT EXISTS cidade TEXT`);
  await pool.query(`ALTER TABLE leituras ADD COLUMN IF NOT EXISTS regiao TEXT`);
  await pool.query(`ALTER TABLE leituras ADD COLUMN IF NOT EXISTS pais TEXT`);
  await pool.query(`ALTER TABLE leituras ADD COLUMN IF NOT EXISTS dispositivo TEXT`);
  await pool.query(`ALTER TABLE leituras ADD COLUMN IF NOT EXISTS sistema TEXT`);
  await pool.query(`ALTER TABLE leituras ADD COLUMN IF NOT EXISTS navegador TEXT`);
}

// Parser leve de User-Agent — só o suficiente pra identificar dispositivo/
// SO/navegador nos indicadores, sem depender de biblioteca externa (o
// serviço é deliberadamente mínimo, ver comentário no topo do arquivo).
function analisarUserAgent(ua) {
  ua = ua || '';
  let dispositivo = 'Desktop';
  if (/iPad/i.test(ua)) dispositivo = 'Tablet (iPad)';
  else if (/Tablet|PlayBook/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) dispositivo = 'Tablet';
  else if (/Mobi|iPhone|Android/i.test(ua)) dispositivo = 'Celular';

  let sistema = 'Outro';
  const iosMatch = ua.match(/OS (\d+)[_.](\d+)/);
  const androidMatch = ua.match(/Android (\d+(\.\d+)?)/);
  const winMatch = ua.match(/Windows NT (\d+\.\d+)/);
  const macMatch = ua.match(/Mac OS X (\d+)[_.](\d+)/);
  if (/iPhone|iPad|iPod/i.test(ua) && iosMatch) sistema = 'iOS ' + iosMatch[1] + '.' + iosMatch[2];
  else if (androidMatch) sistema = 'Android ' + androidMatch[1];
  else if (winMatch) sistema = 'Windows ' + winMatch[1];
  else if (macMatch) sistema = 'macOS ' + macMatch[1] + '.' + macMatch[2];
  else if (/Linux/i.test(ua)) sistema = 'Linux';

  let navegador = 'Outro';
  if (/EdgA|Edge|Edg\//i.test(ua)) navegador = 'Edge';
  else if (/CriOS|Chrome/i.test(ua) && !/OPR|Opera/i.test(ua)) navegador = 'Chrome';
  else if (/FxiOS|Firefox/i.test(ua)) navegador = 'Firefox';
  else if (/OPR|Opera/i.test(ua)) navegador = 'Opera';
  else if (/Instagram/i.test(ua)) navegador = 'Instagram (in-app)';
  else if (/FBAN|FBAV/i.test(ua)) navegador = 'Facebook (in-app)';
  else if (/WhatsApp/i.test(ua)) navegador = 'WhatsApp (in-app)';
  else if (/Safari/i.test(ua)) navegador = 'Safari';

  return { dispositivo, sistema, navegador };
}

// Geolocalização por IP — sem chave/cadastro (ip-api.com, uso não-comercial,
// 45 req/min). É a localização de REDE no momento da leitura (torre de
// celular/wifi local), não um dado salvo em algum cadastro do aparelho —
// exatamente o que o Victor pediu. IP privado/local (rede interna, testes)
// não tem geolocalização nenhuma — devolve tudo em branco de propósito.
async function geolocalizarIp(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|::1|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
    return { cidade: null, regiao: null, pais: null };
  }
  try {
    const controle = new AbortController();
    const timeoutId = setTimeout(() => controle.abort(), 3000);
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`, { signal: controle.signal });
    clearTimeout(timeoutId);
    const d = await resp.json();
    if (d.status !== 'success') return { cidade: null, regiao: null, pais: null };
    return { cidade: d.city || null, regiao: d.regionName || null, pais: d.country || null };
  } catch (e) {
    return { cidade: null, regiao: null, pais: null };
  }
}

// Protege as duas rotas de sincronização (só o HUB TRADX deve conseguir
// chamá-las) — a rota /q/:codigo, essa sim, é sempre pública/sem segredo.
function exigirSegredo(req, res, next) {
  if (!SYNC_SECRET) return res.status(500).json({ erro: 'Serviço não configurado (variável SYNC_SECRET ausente no Render).' });
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) return res.status(401).json({ erro: 'Não autorizado.' });
  next();
}

// O HUB chama isso sempre que cria/edita/exclui/ativa/desativa um QR code, e
// também periodicamente como rede de segurança — substitui a tabela local
// inteira a cada chamada (o HUB é sempre a fonte da verdade, nunca este
// serviço), então não precisa de UPDATE/DELETE seletivo aqui.
app.post('/api/sync-qrcodes', exigirSegredo, async (req, res) => {
  const lista = Array.isArray(req.body.qrcodes) ? req.body.qrcodes : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM qrcodes');
    for (const q of lista) {
      // 22/09/2026: linkDestino agora pode vir vazio (QR criado antes de
      // definir o destino) — só o código é realmente obrigatório pra
      // existir aqui. Sem isso, um QR sem link ficava de fora da
      // sincronização e "sumia" (404 genérico em vez do aviso certo, ver
      // /q/:codigo abaixo).
      if (!q.codigo) continue;
      await client.query(
        'INSERT INTO qrcodes (codigo, link_destino, ativo) VALUES ($1,$2,$3)',
        [q.codigo, q.linkDestino || null, q.ativo !== false]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, total: lista.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro ao sincronizar QR codes:', e.message);
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

// O HUB busca daqui as leituras que ainda não importou, por id incremental
// (guarda o maior id já importado do lado dele) — idempotente, dá pra
// chamar quantas vezes quiser sem duplicar nada.
app.get('/api/leituras', exigirSegredo, async (req, res) => {
  const desdeId = Number(req.query.desdeId) || 0;
  try {
    const r = await pool.query(
      'SELECT id, codigo, lido_em, ip, user_agent, cidade, regiao, pais, dispositivo, sistema, navegador FROM leituras WHERE id > $1 ORDER BY id ASC LIMIT 5000',
      [desdeId]
    );
    res.json({ leituras: r.rows });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── A única rota que importa de verdade: pública, sem autenticação nenhuma,
// porque quem lê é o cliente/loja com o celular dele, nunca alguém logado. ──
app.get('/q/:codigo', async (req, res) => {
  try {
    const r = await pool.query('SELECT link_destino, ativo FROM qrcodes WHERE codigo = $1', [req.params.codigo]);
    if (!r.rows.length || !r.rows[0].ativo) {
      return res.status(404).send('<h1>QR Code não encontrado ou inativo</h1>');
    }
    // 22/09/2026: QR já existe e está ativo, mas ainda não tem link
    // configurado (criado antes de definir o destino) — avisa direito em
    // vez de tentar redirecionar pra "undefined" ou dar 404 enganoso.
    if (!r.rows[0].link_destino) {
      return res.status(200).send('<h1>Conteúdo em preparação</h1><p>Este QR Code ainda não tem um destino configurado. Tente novamente em breve.</p>');
    }
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim().slice(0, 64);
    const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
    // Redireciona JÁ — quem leu o QR não pode esperar a geolocalização (rede
    // externa, ~100-300ms) nem o parse. Registro acontece depois, em
    // background, sem atrasar a experiência de quem escaneou.
    res.redirect(302, r.rows[0].link_destino);
    const { dispositivo, sistema, navegador } = analisarUserAgent(userAgent);
    geolocalizarIp(ip).then(({ cidade, regiao, pais }) => {
      return pool.query(
        `INSERT INTO leituras (codigo, ip, user_agent, cidade, regiao, pais, dispositivo, sistema, navegador)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.codigo, ip, userAgent, cidade, regiao, pais, dispositivo, sistema, navegador]
      );
    }).catch(e => console.error('Erro ao registrar leitura:', e.message));
  } catch (e) {
    console.error('Erro ao processar leitura de QR code:', e.message);
    res.status(500).send('<h1>Erro ao processar QR Code</h1>');
  }
});

app.get('/', (req, res) => {
  res.send('QR HUB TRADX — serviço de redirecionamento ativo.');
});

initDB()
  .then(() => {
    app.listen(PORT, () => console.log('QR HUB TRADX ouvindo na porta ' + PORT));
  })
  .catch(e => {
    console.error('Falha ao inicializar o banco de dados:', e.message);
    process.exit(1);
  });
