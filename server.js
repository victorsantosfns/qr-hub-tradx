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
      'SELECT id, codigo, lido_em, ip, user_agent FROM leituras WHERE id > $1 ORDER BY id ASC LIMIT 5000',
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
    pool.query('INSERT INTO leituras (codigo, ip, user_agent) VALUES ($1,$2,$3)', [req.params.codigo, ip, userAgent])
      .catch(e => console.error('Erro ao registrar leitura:', e.message));
    res.redirect(302, r.rows[0].link_destino);
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
