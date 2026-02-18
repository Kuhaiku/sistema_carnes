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

const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_padrao_trocar_em_producao';

// --- 1. CONEXÃO COM O BANCO DE DADOS ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) console.error('Erro ao conectar no MySQL:', err);
    else console.log('MySQL Conectado!');
});

// --- 2. CONFIGURAÇÃO DO MERCADO PAGO ---
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// --- 3. MIDDLEWARES DE SEGURANÇA ---

// Verifica se o usuário está logado (JWT)
const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Acesso negado' });

    try {
        const tokenReal = token.startsWith('Bearer ') ? token.slice(7, token.length) : token;
        const decoded = jwt.verify(tokenReal, JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

// Verifica se a assinatura do usuário está ativa (SaaS)
const verificarAssinatura = (req, res, next) => {
    const rotasLivres = ['/auth/login', '/auth/register', '/api/criar-pagamento', '/api/pagamento-sucesso', '/api/status-assinatura'];
    if (rotasLivres.some(r => req.path.includes(r))) return next();

    db.query('SELECT * FROM config_sistema WHERE usuario_id = ?', [req.userId || 1], (err, result) => {
        if (err) return next();
        
        // CORREÇÃO: Se não existir config, cria uma JÁ EXPIRADA para forçar pagamento
        if (result.length === 0) {
            db.query("INSERT INTO config_sistema (usuario_id, status_assinatura, data_expiracao) VALUES (?, 'expirada', DATE_SUB(NOW(), INTERVAL 1 DAY))", [req.userId]);
            return res.status(403).json({ error: 'assinatura_expirada' }); // Bloqueia imediatamente
        }

        const config = result[0];
        const agora = new Date();
        const expiracao = new Date(config.data_expiracao);

        // Se expirou ou está marcada como expirada, bloqueia
        if (config.status_assinatura === 'expirada' || agora > expiracao) {
            return res.status(403).json({ error: 'assinatura_expirada' });
        }
        next();
    });
};

// --- 4. ROTAS DE AUTENTICAÇÃO (PÚBLICAS) ---

app.post('/auth/register', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'Preencha todos os campos' });

    try {
        const hash = await bcrypt.hash(senha, 10);
        const [result] = await db.promise().query('INSERT INTO usuarios (email, senha) VALUES (?, ?)', [email, hash]);
        
        // CORREÇÃO: Cria assinatura EXPIRADA (Data de Ontem)
        // Isso fará a tela de bloqueio aparecer no primeiro login
        await db.promise().query("INSERT INTO config_sistema (usuario_id, status_assinatura, data_expiracao) VALUES (?, 'expirada', DATE_SUB(NOW(), INTERVAL 1 DAY))", [result.insertId]);

        res.json({ success: true, message: 'Usuário criado com sucesso!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar usuário. Email já cadastrado?' });
    }
});

app.post('/auth/login', (req, res) => {
    const { email, senha } = req.body;
    
    db.query('SELECT * FROM usuarios WHERE email = ?', [email], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ error: 'Email ou senha incorretos' });
        
        const usuario = results[0];
        const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
        
        if (!senhaCorreta) return res.status(401).json({ error: 'Email ou senha incorretos' });

        const token = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, usuario: { email: usuario.email } });
    });
});

app.use('/api', verificarToken);
app.use('/api', verificarAssinatura);

// --- 5. ROTAS DE PAGAMENTO E ASSINATURA ---

app.get('/api/status-assinatura', (req, res) => {
    db.query('SELECT * FROM config_sistema WHERE usuario_id = ?', [req.userId], (err, result) => {
        // Se não achar, assume expirada para forçar a criação/bloqueio
        if (err || result.length === 0) return res.json({ status: 'expirada', dias_restantes: 0 });
        
        const config = result[0];
        const agora = new Date();
        const expiracao = new Date(config.data_expiracao);
        const diasRestantes = Math.ceil((expiracao - agora) / (1000 * 60 * 60 * 24));
        
        const statusFinal = (config.status_assinatura === 'expirada' || agora > expiracao) ? 'expirada' : 'ativa';

        res.json({ status: statusFinal, dias_restantes: diasRestantes > 0 ? diasRestantes : 0 });
    });
});

app.post('/api/criar-pagamento', async (req, res) => {
    try {
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [{ title: 'Assinatura Mensal - Gestão Carnês', unit_price: 80, quantity: 1, currency_id: 'BRL' }],
                back_urls: {
                    success: `${baseUrl}/api/pagamento-sucesso?user=${req.userId}`,
                    failure: `${baseUrl}`,
                    pending: `${baseUrl}`
                },
                auto_return: 'approved',
            }
        });
        res.json({ init_point: result.init_point });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao gerar pagamento no Mercado Pago' });
    }
});

app.get('/api/pagamento-sucesso', (req, res) => {
    const usuarioId = req.query.user;

    if (!usuarioId) return res.redirect('/?error=sem_usuario');

    // Renova a assinatura (Adiciona 30 dias a partir de HOJE e muda status para ativa)
    db.query(
        "UPDATE config_sistema SET data_expiracao = DATE_ADD(NOW(), INTERVAL 30 DAY), status_assinatura = 'ativa' WHERE usuario_id = ?", 
        [usuarioId], 
        (err) => {
            if (err) console.error("Erro SQL ao renovar:", err);
            res.redirect('/');
        }
    );
});

// --- 6. ROTAS DO SISTEMA (CRUD) ---

app.get('/api/dashboard', (req, res) => {
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
    db.query('SELECT * FROM parcelas WHERE carne_id = ? ORDER BY numero_parcela ASC', [req.params.id], (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

app.post('/api/cadastrar', async (req, res) => {
    const { nome, telefone, numero_carne, valor, ano } = req.body;
    
    if (!nome || !numero_carne || !valor || !ano) {
        return res.status(400).json({ error: 'Dados incompletos' });
    }

    try {
        const [membro] = await db.promise().query(
            'INSERT INTO membros (nome, telefone, usuario_id) VALUES (?, ?, ?)', 
            [nome, telefone, req.userId]
        );
        
        const [carne] = await db.promise().query(
            'INSERT INTO carnes (membro_id, numero_carne, valor_parcela, ano_referencia) VALUES (?, ?, ?, ?)', 
            [membro.insertId, numero_carne, valor, ano]
        );
        
        const parcelas = [];
        for (let i = 1; i <= 12; i++) {
            parcelas.push([carne.insertId, i, `${ano}-${i}-10`]);
        }
        
        await db.promise().query(
            'INSERT INTO parcelas (carne_id, numero_parcela, vencimento) VALUES ?', 
            [parcelas]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao cadastrar carnê' });
    }
});

app.put('/api/parcela/:id', (req, res) => {
    db.query('SELECT status FROM parcelas WHERE id = ?', [req.params.id], (err, r) => {
        if (err || r.length === 0) return res.status(404).json({ error: 'Parcela não encontrada' });
        
        const novoStatus = r[0].status === 'pendente' ? 'pago' : 'pendente';
        const dataPagamento = novoStatus === 'pago' ? new Date() : null;

        db.query('UPDATE parcelas SET status = ?, data_pagamento = ? WHERE id = ?', 
            [novoStatus, dataPagamento, req.params.id], 
            (err) => {
                if (err) return res.status(500).send(err);
                res.json({ novoStatus });
            }
        );
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});