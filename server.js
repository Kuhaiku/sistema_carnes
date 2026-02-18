require('dotenv').config(); // Carrega as variáveis do .env
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. CONEXÃO COM BANCO (Usando .env) ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) console.error('Erro ao conectar no MySQL:', err);
    else console.log('MySQL Conectado via .env!');
});

// --- 2. CONFIGURAÇÃO MERCADO PAGO (Usando .env) ---
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// --- 3. MIDDLEWARE DE BLOQUEIO (Assinatura) ---
const verificarAssinatura = (req, res, next) => {
    // Rotas liberadas mesmo se bloqueado
    const rotasLivres = ['/api/status-assinatura', '/api/criar-pagamento', '/api/pagamento-sucesso'];
    if (rotasLivres.includes(req.path)) return next();

    db.query('SELECT * FROM config_sistema WHERE id = 1', (err, result) => {
        if (err) return res.status(500).send(err);
        
        // Se não tiver config criada, cria uma padrão (30 dias grátis)
        if (result.length === 0) {
            db.query("INSERT INTO config_sistema (id, status_assinatura, data_expiracao) VALUES (1, 'ativa', DATE_ADD(NOW(), INTERVAL 30 DAY))");
            return next();
        }

        const config = result[0];
        const agora = new Date();
        const expiracao = new Date(config.data_expiracao);

        if (agora > expiracao) {
            return res.status(403).json({ error: 'assinatura_expirada' });
        }
        next();
    });
};

app.use(verificarAssinatura);

// --- ROTAS DA ASSINATURA ---
app.get('/api/status-assinatura', (req, res) => {
    db.query('SELECT * FROM config_sistema WHERE id = 1', (err, result) => {
        if (err || result.length === 0) return res.json({ status: 'ativa', dias_restantes: 30 }); // Fallback
        
        const config = result[0];
        const agora = new Date();
        const expiracao = new Date(config.data_expiracao);
        const diasRestantes = Math.ceil((expiracao - agora) / (1000 * 60 * 60 * 24));
        
        res.json({ 
            status: agora > expiracao ? 'expirada' : 'ativa',
            dias_restantes: diasRestantes 
        });
    });
});

app.post('/api/criar-pagamento', async (req, res) => {
    try {
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [{ title: 'Assinatura Mensal - Gestão Carnês', unit_price: 80, quantity: 1, currency_id: 'BRL' }],
                back_urls: {
                    success: `http://localhost:${process.env.PORT}/api/pagamento-sucesso`,
                    failure: `http://localhost:${process.env.PORT}`,
                    pending: `http://localhost:${process.env.PORT}`
                },
                auto_return: 'approved',
            }
        });
        res.json({ init_point: result.init_point });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro no Mercado Pago' });
    }
});

app.get('/api/pagamento-sucesso', (req, res) => {
    // Adiciona 30 dias à data atual
    db.query('UPDATE config_sistema SET data_expiracao = DATE_ADD(NOW(), INTERVAL 30 DAY), status_assinatura = "ativa" WHERE id = 1', () => {
        res.redirect('/');
    });
});

// --- ROTAS DO SISTEMA (CRUD) ---
app.get('/api/dashboard', (req, res) => {
    const sql = `
        SELECT m.id, m.nome, m.telefone, c.id as carne_id, c.numero_carne, 
        (SELECT COUNT(*) FROM parcelas p WHERE p.carne_id = c.id AND p.status = 'pago') as pagas
        FROM membros m JOIN carnes c ON m.id = c.membro_id ORDER BY m.id DESC
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

app.get('/api/carne/:id/parcelas', (req, res) => {
    db.query('SELECT * FROM parcelas WHERE carne_id = ? ORDER BY numero_parcela ASC', [req.params.id], (err, results) => {
        res.json(results);
    });
});

app.post('/api/cadastrar', async (req, res) => {
    const { nome, telefone, numero_carne, valor, ano } = req.body;
    try {
        const [membro] = await db.promise().query('INSERT INTO membros (nome, telefone) VALUES (?, ?)', [nome, telefone]);
        const [carne] = await db.promise().query('INSERT INTO carnes (membro_id, numero_carne, valor_parcela, ano_referencia) VALUES (?, ?, ?, ?)', [membro.insertId, numero_carne, valor, ano]);
        
        const parcelas = [];
        for (let i = 1; i <= 12; i++) parcelas.push([carne.insertId, i, `${ano}-${i}-10`]);
        
        await db.promise().query('INSERT INTO parcelas (carne_id, numero_parcela, vencimento) VALUES ?', [parcelas]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/parcela/:id', (req, res) => {
    db.query('SELECT status FROM parcelas WHERE id = ?', [req.params.id], (err, r) => {
        const novoStatus = r[0].status === 'pendente' ? 'pago' : 'pendente';
        db.query('UPDATE parcelas SET status = ? WHERE id = ?', [novoStatus, req.params.id], () => res.json({ novoStatus }));
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));