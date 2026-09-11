# QR HUB TRADX

Serviço público de redirecionamento dos QR Codes da Central de QR Codes do
HUB TRADX. Existe porque o HUB roda em `hub-tradx.ferreiracosta.corp`, um
domínio **interno** que nenhum celular fora da rede/VPN da empresa consegue
acessar — e um QR code físico precisa funcionar pra qualquer celular, de
qualquer rede.

Este serviço só sabe fazer duas coisas: redirecionar `/q/<codigo>` pro link
de destino de verdade, e registrar que a leitura aconteceu. Nunca fala com o
Oracle, nunca vê senha de ninguém, nunca expõe nada do resto do HUB — é o
único pedaço público de toda a plataforma, de propósito bem pequeno e isolado.

O HUB TRADX (interno) continua sendo a fonte da verdade: ele **empurra** a
lista de QR codes pra cá sempre que algo muda, e **puxa** as leituras daqui
periodicamente. Mesmo padrão de sincronização já usado com sucesso pelo
sistema de Bordados (`bordados-atendimentos`, também no Render).

## Como publicar (uma vez só)

1. **Criar o repositório no GitHub** (mesma conta usada pro `bordados-atendimentos`):
   - Crie um repositório novo, vazio, chamado `qr-hub-tradx`.
   - Nesta pasta, rode:
     ```
     git init
     git add .
     git commit -m "Serviço público de redirecionamento de QR Code"
     git remote add origin https://github.com/<seu-usuario>/qr-hub-tradx.git
     git push -u origin main
     ```

2. **Criar o banco Postgres no Render:**
   - No painel do Render → New → PostgreSQL.
   - Nome sugerido: `qr-hub-tradx-db`. Plano Free está ok pro volume esperado.
   - Depois de criado, não precisa copiar nada à mão — no passo 3 você conecta
     direto.

3. **Criar o Web Service no Render:**
   - New → Web Service → conectar o repositório `qr-hub-tradx` do GitHub.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plano Free está ok.
   - Em **Environment**, adicione:
     - `SYNC_SECRET` → invente uma senha longa (essa MESMA senha precisa ser
       configurada no HUB TRADX como `QR_SYNC_SECRET` — peça pro Victor/DevOps
       fazer isso no Secret do Kubernetes).
     - `DATABASE_URL` → clique em "Add Database" e selecione o banco criado
       no passo 2 — o Render preenche essa variável sozinho.

4. **Pegar a URL pública** que o Render gerou (algo como
   `https://qr-hub-tradx.onrender.com`) e configurar no HUB TRADX como
   `QR_PUBLIC_BASE_URL` — a partir daí, todo QR code novo já sai apontando
   pra essa URL.

## Observação sobre o plano Free do Render

No plano gratuito, o serviço "dorme" depois de ~15min sem uso e demora
alguns segundos pra acordar na primeira leitura depois disso — só afeta a
PRIMEIRA pessoa a ler um QR depois de um tempo parado (vê uma tela de
carregando por alguns segundos antes do redirecionamento), não perde nenhum
dado. Se isso incomodar, dá pra migrar pro plano pago (a partir de uns
US$7/mês) mais pra frente sem mudar nada no código.
