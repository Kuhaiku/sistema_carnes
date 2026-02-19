const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
require('dotenv').config(); // Necessário para ler o .env localmente

const app = express();
app.use(cors());
app.use(express.json());

// Servir os arquivos estáticos (aponta para o index.html na mesma pasta)
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Configuração do Banco de Dados com os dados do .env
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================
// ROTAS DA API
// ==========================================

app.get('/api/carnes', async (req, res) => {
    try {
        const query = `
            SELECT c.id, c.nome, c.telefone, c.numero_carne, 
                   f.numero_folha, f.valor, f.paga 
            FROM carnes c 
            LEFT JOIN folhas f ON c.id = f.carne_id 
            ORDER BY c.id DESC, f.numero_folha ASC
        `;
        const [rows] = await pool.query(query);

        const carnesMap = new Map();
        rows.forEach(row => {
            if (!carnesMap.has(row.id)) {
                carnesMap.set(row.id, {
                    id: row.id,
                    nome: row.nome,
                    telefone: row.telefone,
                    numero: row.numero_carne,
                    expandido: true,
                    folhaAtiva: null, // Controle para o input inline abrir
                    folhas: []
                });
            }
            if (row.numero_folha) {
                carnesMap.get(row.id).folhas.push({
                    index: row.numero_folha,
                    paga: row.paga === 1,
                    valor: parseFloat(row.valor)
                });
            }
        });

        res.json(Array.from(carnesMap.values()));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao buscar carnês' });
    }
});

app.post('/api/carnes', async (req, res) => {
    const { nome, telefone, numero } = req.body;
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
        const [resultCarne] = await connection.query(
            'INSERT INTO carnes (nome, telefone, numero_carne) VALUES (?, ?, ?)',
            [nome, telefone, numero]
        );
        const carneId = resultCarne.insertId;

        const folhasData = [];
        for (let i = 1; i <= 12; i++) {
            folhasData.push([carneId, i]);
        }

        await connection.query(
            'INSERT INTO folhas (carne_id, numero_folha) VALUES ?',
            [folhasData]
        );

        await connection.commit();
        res.status(201).json({ message: 'Carnê gerado com sucesso!', id: carneId });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        if (error.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Número de carnê já existe.' });
        res.status(500).json({ error: 'Erro ao cadastrar carnê' });
    } finally {
        connection.release();
    }
});

app.put('/api/carnes/:id/folhas/:numero_folha', async (req, res) => {
    const { id, numero_folha } = req.params;
    const { valor } = req.body;
    try {
        await pool.query(
            'UPDATE folhas SET paga = 1, valor = ?, data_pagamento = NOW() WHERE carne_id = ? AND numero_folha = ?',
            [valor, id, numero_folha]
        );
        res.json({ message: 'Pagamento registrado!' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao registrar pagamento' });
    }
});

app.delete('/api/carnes/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM carnes WHERE id = ?', [req.params.id]);
        res.json({ message: 'Carnê excluído!' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir carnê' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
