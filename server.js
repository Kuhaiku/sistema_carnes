require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONEXÃO BANCO ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) console.error('Erro MySQL (verifique o .env e se o banco subiu):', err.message);
    else console.log('MySQL Conectado!');
});

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const JWT_SECRET = process.env.JWT_SECRET;

// --- MIDDLEWARES ---

// 1. Autenticação (Login)
const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });

    try {
        const tokenLimpo = token.replace('Bearer ', '');
        const decoded = jwt.verify(tokenLimpo, JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

// 2. Assinatura (Pagamento)
const verificarAssinatura = (req, res, next) => {
    // Rotas liberadas
    if (['/auth/login', '/auth/register', '/api/criar-pagamento', '/api/pagamento-sucesso', '/api/status-assinatura'].some(r => req.path.includes(r))) {
        return next();
    }

    db.query('SELECT * FROM config_sistema WHERE usuario_id = ?', [req.userId], (err, result) => {
        if (err || result.length === 0) return res.status(403).json({ error: 'assinatura_nao_encontrada' });
        
        const config = result[0];
        const agora = new Date();
        const expiracao = new Date(config.data_expiracao);

        if (config.status_assinatura === 'expirada' || agora > expiracao) {
            return res.status(403).json({ error: 'assinatura_expirada' });
        }
        next();
    });
};

// --- ROTAS DE AUTH ---

app.post('/auth/register', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const hash = await bcrypt.hash(senha, 10);
        // Cria usuário
        const [userResult] = await db.promise().query('INSERT INTO usuarios (email, senha) VALUES (?, ?)', [email, hash]);
        
        // Cria assinatura EXPIRADA (Data de Ontem) para forçar pagamento
        await db.promise().query("INSERT INTO config_sistema (usuario_id, status_assinatura, data_expiracao) VALUES (?, 'expirada', DATE_SUB(NOW(), INTERVAL 1 DAY))", [userResult.insertId]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao criar conta. Email já existe?' });
    }
});

app.post('/auth/login', (req, res) => {
    const { email, senha } = req.body;
    db.query('SELECT * FROM usuarios WHERE email = ?', [email], async (err, results) => {
        if (results.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
        
        const user = results[0];
        if (!(await bcrypt.compare(senha, user.senha))) return res.status(401).json({ error: 'Credenciais inválidas' });

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    });
});

app.use('/api', verificarToken);
app.use('/api', verificarAssinatura);

// --- ROTAS DE PAGAMENTO ---

app.get('/api/status-assinatura', (req, res) => {
    db.query('SELECT * FROM config_sistema WHERE usuario_id = ?', [req.userId], (err, result) => {
        if (result.length === 0) return res.json({ status: 'expirada', dias: 0 });
        
        const config = result[0];
        const agora = new Date();
        const expiracao = new Date(config.data_expiracao);
        const dias = Math.ceil((expiracao - agora) / (86400000));
        
        res.json({ 
            status: (config.status_assinatura === 'expirada' || dias <= 0) ? 'expirada' : 'ativa', 
            dias_restantes: dias > 0 ? dias : 0 
        });
    });
});

app.post('/api/criar-pagamento', async (req, res) => {
    try {
        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: [{ title: 'Assinatura Sistema Carnês', unit_price: 80, quantity: 1, currency_id: 'BRL' }],
                back_urls: { 
                    success: `${process.env.BASE_URL}/api/pagamento-sucesso?user=${req.userId}`,
                    failure: `${process.env.BASE_URL}`, 
                    pending: `${process.env.BASE_URL}` 
                },
                auto_return: 'approved'
            }
        });
        res.json({ init_point: response.init_point });
    } catch (e) { res.status(500).json({ error: 'Erro MP' }); }
});

app.get('/api/pagamento-sucesso', (req, res) => {
    const userId = req.query.user;
    if (!userId) return res.redirect('/');
    
    db.query("UPDATE config_sistema SET status_assinatura='ativa', data_expiracao=DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE usuario_id=?", [userId], () => {
        res.redirect('/');
    });
});

// --- ROTAS DO SISTEMA (CRUD) ---

app.get('/api/dashboard', (req, res) => {
    // Busca APENAS membros do usuário logado
    const sql = `
        SELECT m.id, m.nome, m.telefone, c.id as carne_id, c.numero_carne, 
        (SELECT COUNT(*) FROM parcelas p WHERE p.carne_id = c.id AND p.status = 'pago') as pagas
        FROM membros m 
        JOIN carnes c ON m.id = c.membro_id 
        WHERE m.usuario_id = ? 
        ORDER BY m.id DESC
    `;
    db.query(sql, [req.userId], (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

app.get('/api/carne/:id/parcelas', (req, res) => {
    db.query('SELECT * FROM parcelas WHERE carne_id = ? ORDER BY numero_parcela ASC', [req.params.id], (err, r) => res.json(r));
});

app.post('/api/cadastrar', async (req, res) => {
    const { nome, telefone, numero_carne, valor, ano } = req.body;
    try {
        // Insere Membro vinculado ao Usuario Logado
        const [membro] = await db.promise().query('INSERT INTO membros (usuario_id, nome, telefone) VALUES (?, ?, ?)', [req.userId, nome, telefone]);
        const [carne] = await db.promise().query('INSERT INTO carnes (membro_id, numero_carne, valor_parcela, ano_referencia) VALUES (?, ?, ?, ?)', [membro.insertId, numero_carne, valor, ano]);
        
        const parcelas = [];
        for (let i = 1; i <= 12; i++) parcelas.push([carne.insertId, i, `${ano}-${i}-10`]);
        await db.promise().query('INSERT INTO parcelas (carne_id, numero_parcela, vencimento) VALUES ?', [parcelas]);
        
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/parcela/:id', (req, res) => {
    db.query('SELECT status FROM parcelas WHERE id=?', [req.params.id], (err, r) => {
        const novo = r[0].status === 'pendente' ? 'pago' : 'pendente';
        db.query('UPDATE parcelas SET status=?, data_pagamento=? WHERE id=?', [novo, novo === 'pago' ? new Date() : null, req.params.id], () => res.json({ novo }));
    });
});

app.listen(process.env.PORT || 3000, () => console.log('Servidor ON'));