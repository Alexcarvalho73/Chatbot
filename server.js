const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const oracledb = require('oracledb');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json());
app.use(cookieParser());

const ACCESS_TOKEN = 'Alinne05@token';

// Middleware de Autenticação
const authMiddleware = (req, res, next) => {
    console.log(`[AUTH] Path original recebido: ${req.path} | Query: ${JSON.stringify(req.query)} | URL: ${req.url}`);
    
    // Suporte para o token enviado na query ou no cookie
    const token = req.query.token || req.cookies['chatbot_auth'];

    if (token === ACCESS_TOKEN) {
        // Se o token veio na URL e está correto, gera o cookie
        if (req.query.token) {
            res.cookie('chatbot_auth', ACCESS_TOKEN, { 
                maxAge: 86400000 * 30, // 30 dias
                httpOnly: true, 
                path: '/' 
            });
            console.log('[AUTH] Token validado pela URL. Cookie gerado.');
        }
        
        // Deixa prosseguir normalmente (o frontend fará o clean url via replaceState)
        return next();
    }

    console.log('[AUTH] Falha: Token ou Cookie inválido/ausente.');

    // Se for uma requisição de API, retorna JSON
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Acesso negado. Token inválido.' });
    }

    // Caso contrário, retorna uma página simples de erro
    res.status(403).send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1 style="color: #e11d48;">Acesso Negado</h1>
            <p>Você não tem permissão para acessar o dashboard do ChatBot diretamente.</p>
            <p>Por favor, utilize o botão oficial dentro do Sistema de Dízimo.</p>
        </div>
    `);
};

// Aplica o middleware em todas as rotas (exceto se você quiser abrir algo público)
app.use(authMiddleware);

const server = http.createServer(app);
const io = socketIo(server);

// Configurações Oracle (Usuario Dizimo)
const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: path.join(__dirname, 'DriveOracle'),
    walletPassword: "Alinne05@ora"
};

let dbStatus = false;

// Inicialização Oracle
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [ oracledb.CLOB ]; // Garante que CLOBs venham como string
oracledb.autoCommit = true;

// Define TNS_ADMIN globalmente na inicialização para o driver localizar tnsnames.ora e sqlnet.ora
process.env.TNS_ADMIN = oracleConfig.walletLocation;

async function getOracleConnection() {
    try {
        // Define TNS_ADMIN para localizar tnsnames.ora e sqlnet.ora na Wallet
        process.env.TNS_ADMIN = oracleConfig.walletLocation;

        const conn = await oracledb.getConnection({
            user: oracleConfig.user,
            password: oracleConfig.password,
            connectString: oracleConfig.connectString,
            walletLocation: oracleConfig.walletLocation,
            walletPassword: oracleConfig.walletPassword,
            configDir: oracleConfig.walletLocation
        });

        console.log('[DB] Conectado ao Oracle com sucesso!');

        await conn.execute("ALTER SESSION SET NLS_COMP = LINGUISTIC");
        await conn.execute("ALTER SESSION SET NLS_SORT = BINARY_AI");

        return conn;
    } catch (err) {
        console.error('[DB] ERRO NA CONEXÃO ORACLE:', err.message);
        throw err;
    }
}

// Criação da tabela de fluxos no Oracle se não existir
async function initOracle() {
    let conn;
    try {
        conn = await getOracleConnection();
        // Verifica se a tabela flows existe
        const checkTable = await conn.execute(`
            SELECT table_name FROM user_tables WHERE table_name = 'FLOWS'
        `);

        if (checkTable.rows.length === 0) {
            console.log('Table FLOWS not found. Creating...');
            await conn.execute(`
                CREATE TABLE flows (
                    id VARCHAR2(100) PRIMARY KEY,
                    triggers VARCHAR2(1000),
                    message CLOB,
                    options CLOB
                )
            `);
            console.log('Table FLOWS created successfully.');
        }

        // Garante que o fluxo 'main_menu' existe
        const checkFlow = await conn.execute(`
            SELECT id FROM flows WHERE id = 'main_menu'
        `);

        if (checkFlow.rows.length === 0) {
            console.log('Seeding default main_menu flow...');
            const mainMenuData = {
                id: 'main_menu',
                triggers: 'menu, ajuda, oi',
                message: "*Menu da Paróquia* 🙏\n\nEscolha uma opção:\n1️⃣ *Servir*: Candidatar-se para trabalhar em uma missa.\n2️⃣ *Missas*: Ver horários das missas do mês.\n\n_Digite o número da opção desejada._",
                options: JSON.stringify({
                    "1": { "type": "function", "value": "fluxoServir" },
                    "2": { "type": "function", "value": "listarMissas" }
                })
            };
            await conn.execute(`
                INSERT INTO flows (id, triggers, message, options) 
                VALUES (:id, :triggers, :message, :options)
            `, mainMenuData);
            console.log('Default main_menu seeded.');
        }
    } catch (err) {
        console.error('Error initializing Oracle:', err);
        dbStatus = false;
    } finally {
        if (conn) {
            dbStatus = true;
            await conn.close();
        }
    }
}

let chatFlows = {};

// Função para recarregar fluxos do Oracle para a memória
async function loadFlowsFromDB() {
    let conn;
    try {
        conn = await getOracleConnection();
        const result = await conn.execute("SELECT id, triggers, message, options FROM flows");
        const newFlows = {};
        result.rows.forEach(row => {
            newFlows[row.ID] = {
                trigger: row.TRIGGERS ? row.TRIGGERS.split(',').map(t => t.trim().toLowerCase()) : null,
                message: row.MESSAGE,
                options: JSON.parse(row.OPTIONS)
            };
        });
        chatFlows = newFlows;
        console.log('Flows loaded from Oracle Database.');
    } catch (err) {
        console.error('Error loading flows from Oracle:', err);
    } finally {
        if (conn) await conn.close();
    }
}

async function initialize() {
    console.log('--- System Initialization Started ---');
    try {
        await initOracle();
        await loadFlowsFromDB();
        console.log('--- Initialization Complete ---');
    } catch (err) {
        console.error('CRITICAL ERROR DURING INITIALIZATION:', err);
    }
}

initialize();

let isReady = false;
let isInitializing = false;
let lastQr = null;

// Gerenciamento de Estados
const userStates = {};

// Funções Internas para Chamadas Dinâmicas
const internalFunctions = {
    notificarAtendente: async (msg, contact) => {
        console.log(`🔔 Notificando atendente sobre o contato: ${contact.number}`);
        return "Um atendente foi noticiado e entrará em contato em breve.";
    },
    buscarDizimistaPorTelefone: async (phone) => {
        let cleanPhone = phone.replace(/^(\+?55|55)/, '').replace(/\D/g, ''); // Remove prefixos de país e não-dígitos
        
        // Lógica para acrescentar o 9º dígito (Brasil) caso o WhatsApp envie apenas 8 dígitos
        if (cleanPhone.length === 10) { // Formato: DD + 8 dígitos
            cleanPhone = cleanPhone.slice(0, 2) + '9' + cleanPhone.slice(2);
        } else if (cleanPhone.length === 11 && cleanPhone.startsWith('0')) { // Formato: 0DD + 8 dígitos
            cleanPhone = cleanPhone.slice(0, 3) + '9' + cleanPhone.slice(3);
        }
        let conn;
        try {
            conn = await getOracleConnection();
            const resDiz = await conn.execute(`
                SELECT ID_DIZIMISTA, NOME, APELIDO FROM DIZIMISTAS 
                WHERE REGEXP_REPLACE(TELEFONE, '[^0-9]', '') LIKE :phone
            `, { phone: '%' + cleanPhone });

            if (resDiz.rows.length > 0) {
                const r = resDiz.rows[0];
                console.log(`[ID] Dizimista localizado: ${r.NOME} (ID: ${r.ID_DIZIMISTA})`);
                return { id: r.ID_DIZIMISTA, nome: r.NOME, apelido: r.APELIDO || r.NOME };
            }
            console.log(`[ID] Nenhum dizimista encontrado para o telefone: ${cleanPhone}`);
            return null;
        } catch (err) {
            console.error('Erro buscarDizimistaPorTelefone:', err);
            return null;
        } finally {
            if (conn) await conn.close();
        }
    },
    listarMissas: async (msg, contact) => {
        let conn;
        try {
            conn = await getOracleConnection();
            // Missas do mês a partir de hoje
            const result = await conn.execute(`
                SELECT TO_CHAR(TO_DATE(DATA_MISSA, 'YYYY-MM-DD'), 'DD/MM') as DATA, HORA, COMUNIDADE, CELEBRANTE 
                FROM MISSAS 
                WHERE TO_DATE(DATA_MISSA, 'YYYY-MM-DD') >= TRUNC(SYSDATE) 
                AND TO_DATE(DATA_MISSA, 'YYYY-MM-DD') <= LAST_DAY(SYSDATE)
                AND STATUS = 1
                ORDER BY DATA_MISSA, HORA
            `);
            
            if (result.rows.length === 0) return "Não há missas ativas agendadas para o restante deste mês.";

            let response = "*📅 MISSAS DO MÊS*\n\n";
            result.rows.forEach(r => {
                response += `📍 *${r.DATA} - ${r.HORA}*\nComunidade: ${r.COMUNIDADE}\n`;
                if (r.CELEBRANTE) {
                    response += `Celebrante: ${r.CELEBRANTE}\n`;
                }
                response += "\n";
            });
            return response;
        } catch (err) {
            console.error('Erro listarMissas:', err);
            return "Erro ao buscar missas. Tente novamente mais tarde.";
        } finally {
            if (conn) await conn.close();
        }
    },
    fluxoServir: async (msg, contact, userData, pMonthOffset = 0) => {
        const phone = contact.number;
        const idDizimista = userData.id;
        const nomeDizimista = userData.apelido || userData.nome;

        let conn;
        try {
            conn = await getOracleConnection();
            
            // 2. Buscar Pastorais que ele serve
            const resPast = await conn.execute(`
                SELECT ID_PASTORAL FROM DIZIMISTA_PASTORAL WHERE ID_DIZIMISTA = :id
            `, { id: idDizimista });

            if (resPast.rows.length === 0) {
                return `Olá ${nomeDizimista}! Verifiquei que você não está vinculado a nenhuma pastoral no momento.`;
            }

            const idsPastoral = resPast.rows.map(r => r.ID_PASTORAL);

            // 3. Buscar Missas para essas pastorais (com nome da pastoral e verificação se já está inscrito)
            const resMissas = await conn.execute(`
                SELECT m.ID_MISSA, TO_CHAR(TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD'), 'DD/MM') as DATA, m.HORA, m.COMUNIDADE, 
                       mp.QUANTIDADE_SERVOS, mp.ID_PASTORAL, p.NOME as PASTORAL_NOME,
                       (SELECT COUNT(*) FROM MISSA_SERVOS ms WHERE ms.ID_MISSA = m.ID_MISSA AND ms.ID_PASTORAL = mp.ID_PASTORAL) as ATUAIS,
                       (SELECT COUNT(*) FROM MISSA_SERVOS ms WHERE ms.ID_MISSA = m.ID_MISSA AND ms.ID_DIZIMISTA = :idDizimista) as JA_INSCRITO,
                       (SELECT LISTAGG(NVL(d.APELIDO, d.NOME), ', ') WITHIN GROUP (ORDER BY NVL(d.APELIDO, d.NOME)) 
                        FROM MISSA_SERVOS ms2 JOIN DIZIMISTAS d ON ms2.ID_DIZIMISTA = d.ID_DIZIMISTA 
                        WHERE ms2.ID_MISSA = m.ID_MISSA AND ms2.ID_PASTORAL = mp.ID_PASTORAL) as SERVOS_ATUAIS
                FROM MISSAS m
                JOIN MISSA_PASTORAL mp ON m.ID_MISSA = mp.ID_MISSA
                JOIN PASTORAIS p ON mp.ID_PASTORAL = p.ID_PASTORAL
                WHERE mp.ID_PASTORAL IN (${idsPastoral.join(',')})
                AND TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD') >= TRUNC(SYSDATE)
                AND TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD') >= ADD_MONTHS(TRUNC(SYSDATE, 'MM'), :monthOffset)
                AND TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD') <= LAST_DAY(ADD_MONTHS(TRUNC(SYSDATE, 'MM'), :monthOffset))
                AND m.STATUS = 1
                ORDER BY m.DATA_MISSA, m.HORA
            `, { idDizimista, monthOffset: pMonthOffset });

            if (resMissas.rows.length === 0) {
                return `Olá ${nomeDizimista}! Não encontrei missas agendadas para as suas pastorais neste período.`;
            }

            // Guardar no estado para a seleção
            userStates[phone] = { 
                flowId: 'servir_selecao', 
                idDizimista, 
                nomeDizimista: userData.nome,
                apelidoDizimista: userData.apelido,
                monthOffset: pMonthOffset,
                availableMasses: resMissas.rows 
            };

            console.log(`[FLOW] Oferecendo ${resMissas.rows.length} missas para ${nomeDizimista} (Mês Offset: ${pMonthOffset})`);

            let response = `Olá *${nomeDizimista}*! 👋\nEscolha em qual missa você deseja servir:\n\n`;
            resMissas.rows.forEach((r, idx) => {
                let statusMsg = "";
                let vagasRestantes = r.QUANTIDADE_SERVOS - r.ATUAIS;

                const linhasVagas = [];
                for(let i = 0; i < vagasRestantes; i++) {
                    linhasVagas.push("✅ - Disponível");
                }

                if (vagasRestantes <= 0) {
                    if (r.JA_INSCRITO > 0) {
                        statusMsg = "🚩 *Você já está servindo aqui*";
                    } else {
                        statusMsg = "❌ - Vagas Esgotadas";
                    }
                } else {
                    if (r.JA_INSCRITO > 0) {
                        statusMsg = "🚩 *Você já está servindo aqui*\n" + linhasVagas.join('\n');
                    } else {
                        statusMsg = linhasVagas.join('\n');
                    }
                }

                
                let servosStr = "";
                if (r.SERVOS_ATUAIS) {
                    // Separa a string de servos e quebra por linha, colocando o usuario atual em Negrito
                    const list = r.SERVOS_ATUAIS.split(', ').map(n => n.trim() === nomeDizimista.trim() ? `*${n.trim()}*` : n.trim());
                    servosStr = `\n${list.join('\n')}`;
                }

                // O layout final
                response += `*${idx + 1}* - ${r.DATA} às ${r.HORA}\n📍 ${r.COMUNIDADE}\n🛠 Pastoral: *${r.PASTORAL_NOME}*${servosStr}\n${statusMsg}\n\n`;
            });
            response += "*0* - Voltar ao Menu Anterior\n*99* - Exibe missas do próximo mês\n\nResponda com o *NÚMERO* da opção desejada.";
            return response;

        } catch (err) {
            console.error('Erro fluxoServir:', err);
            return "Erro ao processar sua solicitação de serviço.";
        } finally {
            if (conn) await conn.close();
        }
    },
    fluxoCancelarServir: async (msg, contact, userData, pMonthOffset = 0) => {
        const phone = contact.number;
        const idDizimista = userData.id;
        const nomeDizimista = userData.apelido || userData.nome;

        let conn;
        try {
            conn = await getOracleConnection();
            
            // Buscar Missas que o usuário está inscrito
            const resMissas = await conn.execute(`
                SELECT m.ID_MISSA, TO_CHAR(TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD'), 'DD/MM') as DATA, m.HORA, m.COMUNIDADE, 
                       ms.ID_PASTORAL, p.NOME as PASTORAL_NOME
                FROM MISSA_SERVOS ms
                JOIN MISSAS m ON ms.ID_MISSA = m.ID_MISSA
                JOIN PASTORAIS p ON ms.ID_PASTORAL = p.ID_PASTORAL
                WHERE ms.ID_DIZIMISTA = :idDizimista
                AND TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD') >= TRUNC(SYSDATE)
                AND TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD') >= ADD_MONTHS(TRUNC(SYSDATE, 'MM'), :monthOffset)
                AND TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD') <= LAST_DAY(ADD_MONTHS(TRUNC(SYSDATE, 'MM'), :monthOffset))
                ORDER BY m.DATA_MISSA, m.HORA
            `, { idDizimista, monthOffset: pMonthOffset });

            if (resMissas.rows.length === 0) {
                return `Olá ${nomeDizimista}! Não encontrei nenhuma missa em que você esteja escalado(a) neste período para cancelar.`;
            }

            // Guardar no estado para a seleção de cancelamento
            userStates[phone] = { 
                flowId: 'cancelar_selecao', 
                idDizimista, 
                nomeDizimista: userData.nome,
                apelidoDizimista: userData.apelido,
                monthOffset: pMonthOffset,
                availableMasses: resMissas.rows 
            };

            let response = `Olá *${nomeDizimista}*! 👋\nVocê está escalado(a) nas seguintes missas.\nEscolha o número da missa que deseja *CANCELAR* sua participação:\n\n`;
            resMissas.rows.forEach((r, idx) => {
                response += `*${idx + 1}* - ${r.DATA} às ${r.HORA}\n📍 ${r.COMUNIDADE}\n🛠 Pastoral: *${r.PASTORAL_NOME}*\n\n`;
            });
            response += "*0* - Voltar ao Menu Anterior\n*99* - Exibe missas do próximo mês\n\nResponda com o *NÚMERO* da missa que deseja desmarcar.";
            return response;

        } catch (err) {
            console.error('Erro fluxoCancelarServir:', err);
            return "Erro ao processar sua solicitação de consulta.";
        } finally {
            if (conn) await conn.close();
        }
    }
};

app.use(express.static(path.join(__dirname, 'public')));

// --- API de Configuração de Fluxos ---
app.get('/api/flows', async (req, res) => {
    let conn;
    try {
        conn = await getOracleConnection();
        const result = await conn.execute("SELECT id, triggers, message, options FROM flows");
        res.json(result.rows.map(r => ({
            id: r.ID,
            triggers: r.TRIGGERS,
            message: r.MESSAGE,
            options: JSON.parse(r.OPTIONS)
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) await conn.close();
    }
});

app.post('/api/flows', async (req, res) => {
    const { id, triggers, message, options } = req.body;
    const optionsStr = JSON.stringify(options);
    let conn;
    try {
        conn = await getOracleConnection();
        // Em Oracle, usamos MERGE ou verificamos se existe para o INSERT/UPDATE
        const mergeSql = `
            MERGE INTO flows f
            USING (SELECT :id as id FROM dual) src
            ON (f.id = src.id)
            WHEN MATCHED THEN
                UPDATE SET triggers = :triggers, message = :message, options = :options
            WHEN NOT MATCHED THEN
                INSERT (id, triggers, message, options) VALUES (:id, :triggers, :message, :options)
        `;
        await conn.execute(mergeSql, { id, triggers, message, options: optionsStr });
        await loadFlowsFromDB(); // Recarrega em memória
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) await conn.close();
    }
});

app.delete('/api/flows/:id', async (req, res) => {
    let conn;
    try {
        conn = await getOracleConnection();
        await conn.execute("DELETE FROM flows WHERE id = :id", { id: req.params.id });
        await loadFlowsFromDB();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) await conn.close();
    }
});
app.get('/api/test-db', async (req, res) => {
    let conn;
    try {
        conn = await getOracleConnection();
        const testId = 'test_' + Date.now();
        await conn.execute(
            "INSERT INTO flows (id, triggers, message, options) VALUES (:id, :triggers, :message, :options)",
            {
                id: testId,
                triggers: 'test',
                message: 'Conexão Oracle funcionando!',
                options: JSON.stringify({ 'test': { type: 'reply', value: 'OK' } })
            }
        );
        res.json({ success: true, message: 'Registro gravado com sucesso!', id: testId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) await conn.close();
    }
});

app.get('/api/db-status', (req, res) => {
    res.json({ connected: dbStatus });
});

app.get('/api/dizimistas', async (req, res) => {
    let conn;
    try {
        conn = await getOracleConnection();
        // Busca dizimistas que possuem celular preenchido
        const result = await conn.execute(`
            SELECT NOME, TELEFONE 
            FROM DIZIMISTAS 
            WHERE TELEFONE IS NOT NULL AND ROWNUM <= 500
            ORDER BY NOME ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar dizimistas:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) await conn.close();
    }
});
// ------------------------------------

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "main-session"
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-extensions',
            '--no-zygote'
        ],
    }
});

client.on('qr', (qr) => {
    lastQr = qr;
    isReady = false;
    isInitializing = false;
    // Escaneie no terminal também se necessário
    qrcode.generate(qr, { small: true });
    // Envia o QR code para o frontend
    io.emit('qr', qr);
    console.log('QR RECEIVED', qr);
});

client.on('ready', () => {
    isReady = true;
    isInitializing = false;
    lastQr = null;
    console.log('Client is ready!');
    io.emit('ready', 'WhatsApp está pronto!');
});

client.on('authenticated', () => {
    isReady = true;
    isInitializing = false;
    console.log('AUTHENTICATED');
    io.emit('authenticated', 'Autenticado com sucesso!');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    isInitializing = false;
    io.emit('message', 'Falha na autenticação: ' + msg);
});

client.on('message_create', async msg => {
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    // Envia a mensagem (recebida ou enviada) para o Dashboard com contexto do chat
    io.emit('new-message', {
        chatId: chat.id._serialized,
        from: contact.number,
        name: contact.pushname || contact.name || contact.number,
        body: msg.body,
        timestamp: new Date(msg.timestamp * 1000).toLocaleTimeString(),
        fromMe: msg.fromMe
    });

    // Lógica de resposta automática dinâmica
    if (!msg.fromMe) {
        const phone = contact.number;
        const text = msg.body.trim().toLowerCase();
        
        // --- 0. COMANDOS GLOBAIS DE NAVEGAÇÃO ---
        if (text === 'menu' || text === 'voltar') {
            console.log(`[NAV] Usuário ${phone} solicitou retorno ao menu principal.`);
            const currentState = userStates[phone];
            const mainFlow = chatFlows['main_menu'];
            if (mainFlow) {
                await msg.reply(mainFlow.message);
                userStates[phone] = { 
                    flowId: 'main_menu',
                    idDizimista: currentState ? currentState.idDizimista : null,
                    nomeDizimista: currentState ? currentState.nomeDizimista : null,
                    apelidoDizimista: currentState ? currentState.apelidoDizimista : null
                };
            }
            return;
        }

        let state = userStates[phone];

        if (!state) {
            // Identifica o usuário logo no primeiro contato
            const userData = await internalFunctions.buscarDizimistaPorTelefone(phone);

            if (!userData) {
                const displayNumber = phone.replace(/^55/, '');
                await msg.reply(`Olá! 👋 Identificamos que este número ${displayNumber} não possui cadastro em nossa paróquia. Para utilizar o chatbot, por favor, entre em contato com a secretaria.`);
                return;
            }

            // Busca o fluxo do Menu Principal no Banco
            const mainFlow = chatFlows['main_menu'];
            if (!mainFlow) {
                await msg.reply(`*Olá, ${userData.nome}!* 🙏\nSeja bem-vindo. No momento nosso menu está em manutenção.`);
                return;
            }

            // Saudação baseada no horário
            const hour = new Date().getHours();
            let saudacao = "Boa noite";
            if (hour >= 5 && hour < 12) saudacao = "Bom dia";
            else if (hour >= 12 && hour < 18) saudacao = "Boa tarde";

            const welcomeMsg = `*${saudacao}, ${userData.nome}!* 🙏\n${mainFlow.message}`;
            
            userStates[phone] = { 
                flowId: 'main_menu',
                idDizimista: userData.id,
                nomeDizimista: userData.nome,
                apelidoDizimista: userData.apelido
            };

            await msg.reply(welcomeMsg);
            console.log(`[FLOW-DB] Menu Principal (DB) enviado para ${userData.nome}`);
            return;
        }

        // Se já existe um estado (Usuário já identificado)
        // Garante que a identidade está presente
        if (!state.idDizimista || !state.nomeDizimista) {
            console.log(`[STATE] Recuperando identidade para ${phone}...`);
            const userData = await internalFunctions.buscarDizimistaPorTelefone(phone);
            if (userData) {
                state.idDizimista = userData.id;
                state.nomeDizimista = userData.nome;
                state.apelidoDizimista = userData.apelido;
            }
        }

        const currentFlow = chatFlows[state.flowId];
        
        if (currentFlow && currentFlow.options && currentFlow.options[text]) {
            const option = currentFlow.options[text];
            console.log(`[STATE] Usuário ${phone} selecionou opção ${text} no fluxo ${state.flowId} (Tipo: ${option.type})`);

            if (option.type === 'reply') {
                await msg.reply(option.value);
            } else if (option.type === 'flow') {
                state.flowId = option.value;
                const nextFlow = chatFlows[state.flowId];
                if (nextFlow) {
                    await msg.reply(nextFlow.message);
                }
            } else if (option.type === 'function') {
                const func = internalFunctions[option.value];
                if (func) {
                    const result = await func(msg, contact, { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista });
                    await msg.reply(result);
                } else {
                    console.error(`Função ${option.value} não encontrada.`);
                    await msg.reply("Erro ao processar opção dinâmica.");
                }
            }
        } else if (state.flowId === 'servir_selecao') {
            console.log(`[STATE] Usuário ${phone} selecionando missa: ${text}`);

            if (text === '0') {
                const mainFlow = chatFlows['main_menu'];
                if (mainFlow) {
                    await msg.reply(mainFlow.message);
                    userStates[phone] = { 
                        flowId: 'main_menu', 
                        idDizimista: state.idDizimista, 
                        nomeDizimista: state.nomeDizimista,
                        apelidoDizimista: state.apelidoDizimista 
                    };
                }
                return;
            }

            if (text === '99') {
                const func = internalFunctions.fluxoServir;
                const newOffset = (state.monthOffset || 0) + 1;
                const result = await func(msg, contact, { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista }, newOffset);
                await msg.reply(result);
                return;
            }

            const index = parseInt(text) - 1;
            if (!isNaN(index) && state.availableMasses && state.availableMasses[index]) {
                const selectedMass = state.availableMasses[index];
                
                if (selectedMass.JA_INSCRITO > 0) {
                    await msg.reply("Você já está inscrito para servir nesta missa! Escolha outra opção ou digite *0* para voltar.");
                    return;
                }

                if (selectedMass.ATUAIS >= selectedMass.QUANTIDADE_SERVOS) {
                    await msg.reply("Esta missa já está com o quadro de servos completo. Por favor, escolha outra.");
                    return;
                }

                // Efetivar candidatura
                let conn;
                try {
                    conn = await getOracleConnection();
                    
                    // Verificar se já não está inscrito
                    const check = await conn.execute(`
                        SELECT 1 FROM MISSA_SERVOS WHERE ID_MISSA = :m AND ID_DIZIMISTA = :d
                    `, { m: selectedMass.ID_MISSA, d: state.idDizimista });

                    if (check.rows.length > 0) {
                        await msg.reply("Você já está inscrito para servir nesta missa!");
                    } else {
                        await conn.execute(`
                            INSERT INTO MISSA_SERVOS (ID_MISSA, ID_DIZIMISTA, ID_PASTORAL) 
                            VALUES (:m, :d, :p)
                        `, { 
                            m: selectedMass.ID_MISSA, 
                            d: state.idDizimista, 
                            p: selectedMass.ID_PASTORAL 
                        });
                        await msg.reply(`✅ Confirmado! Você foi escalado para servir na missa de *${selectedMass.DATA} às ${selectedMass.HORA}*. Deus abençoe!`);
                    }
                    delete userStates[phone];
                } catch (err) {
                    console.error('Erro ao salvar missa_servos:', err);
                    await msg.reply("Houve um erro ao confirmar sua escala. Tente novamente.");
                } finally {
                    if (conn) await conn.close();
                }
            } else {
                await msg.reply("Opção inválida. Por favor, escolha o número correspondente à missa na lista acima.");
            }
        } else if (state.flowId === 'cancelar_selecao') {
            console.log(`[STATE] Usuário ${phone} selecionando missa para cancelar: ${text}`);

            if (text === '0') {
                const mainFlow = chatFlows['main_menu'];
                if (mainFlow) {
                    await msg.reply(mainFlow.message);
                    userStates[phone] = { 
                        flowId: 'main_menu', 
                        idDizimista: state.idDizimista, 
                        nomeDizimista: state.nomeDizimista,
                        apelidoDizimista: state.apelidoDizimista 
                    };
                }
                return;
            }

            if (text === '99') {
                const func = internalFunctions.fluxoCancelarServir;
                const newOffset = (state.monthOffset || 0) + 1;
                const result = await func(msg, contact, { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista }, newOffset);
                await msg.reply(result);
                return;
            }

            const index = parseInt(text) - 1;
            if (!isNaN(index) && state.availableMasses && state.availableMasses[index]) {
                const selectedMass = state.availableMasses[index];
                
                let conn;
                try {
                    conn = await getOracleConnection();
                    
                    // Excluir inscrição
                    await conn.execute(`
                        DELETE FROM MISSA_SERVOS WHERE ID_MISSA = :m AND ID_DIZIMISTA = :d
                    `, { m: selectedMass.ID_MISSA, d: state.idDizimista });

                    await msg.reply(`✅ Confirmação: Sua participação na missa de *${selectedMass.DATA} às ${selectedMass.HORA}* foi cancelada. Os coordenadores foram notificados.`);

                    // Buscar coordenadores da pastoral
                    try {
                        const resCoord = await conn.execute(`
                            SELECT d.TELEFONE, d.NOME 
                            FROM DIZIMISTA_PASTORAL dp
                            JOIN DIZIMISTAS d ON dp.ID_DIZIMISTA = d.ID_DIZIMISTA
                            WHERE dp.ID_PASTORAL = :p AND dp.PAPEL = 'C'
                        `, { p: selectedMass.ID_PASTORAL });

                        // Notificar coordenadores via WhatsApp
                        for (const coord of resCoord.rows) {
                            if (coord.TELEFONE) {
                                let coordPhone = coord.TELEFONE.replace(/\D/g, '');
                                if (coordPhone.length >= 10 && coordPhone.length <= 11) {
                                    coordPhone = '55' + coordPhone;
                                    const sms = `⚠️ *Aviso de Desistência de Escala*\n\nOlá coordenador(a) *${coord.NOME}*!\nO servo *${state.apelidoDizimista || state.nomeDizimista}* acabou de desmarcar sua participação na missa do dia *${selectedMass.DATA} às ${selectedMass.HORA}* (Pastoral: ${selectedMass.PASTORAL_NOME}).\n\n_Mensagem automática do Sistema de Chatbot da Paróquia._`;
                                    // Ignora erro no disparo para que o script prossiga
                                    await client.sendMessage(coordPhone + '@c.us', sms).catch(e => console.error("Erro ao notificar whats", e));
                                }
                            }
                        }
                    } catch (errCoord) {
                        console.error("Erro ao buscar coordenadores ou enviar alerta:", errCoord);
                    }

                    delete userStates[phone];
                } catch (err) {
                    console.error('Erro ao excluir missa_servos:', err);
                    await msg.reply("Houve um erro no banco de dados ao tentar processar seu cancelamento.");
                } finally {
                    if (conn) await conn.close();
                }
            } else {
                await msg.reply("Opção inválida. Por favor, escolha o número correspondente à missa na lista acima.");
            }
        } else {
            // Fallback para qualquer outra coisa: volta ao menu principal preservando ID
            const mainFlow = chatFlows['main_menu'];
            if (mainFlow) {
                await msg.reply(mainFlow.message);
                userStates[phone] = { 
                    flowId: 'main_menu',
                    idDizimista: state.idDizimista,
                    nomeDizimista: state.nomeDizimista,
                    apelidoDizimista: state.apelidoDizimista
                };
            }
        }
    }
});

// Eventos do Socket.io do Frontend
io.use((socket, next) => {
    // Verifica token no handshake ou cookie
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    const cookie = socket.handshake.headers.cookie;

    if (token === ACCESS_TOKEN || (cookie && cookie.includes(`chatbot_auth=${ACCESS_TOKEN}`))) {
        return next();
    }
    console.log('[Socket] Bloqueado: Conexão sem autenticação válida.');
    next(new Error('Authentication error'));
});

io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('init-whatsapp', () => {
        if (isReady) {
            socket.emit('ready', 'Já está conectado!');
            return;
        }
        if (isInitializing) {
            socket.emit('message', 'WhatsApp já está inicializando... aguarde.');
            return;
        }

        console.log('[WWEB] Inicialização manual solicitada via painel.');
        isInitializing = true;
        socket.emit('message', 'Iniciando navegador... Isso pode levar até 1 minuto em servidores lentos.');
        
        // Timeout de emergência: 2 minutos
        const initTimeout = setTimeout(() => {
            if (isInitializing) {
                isInitializing = false;
                console.log('[WWEB] TIMEOUT CRÍTICO: Browser não respondeu.');
                socket.emit('message', 'Erro: O navegador demorou muito para responder. Tente novamente em instantes.');
            }
        }, 120000);

        client.initialize().then(() => {
            console.log('[WWEB] client.initialize() promise resolved');
        }).catch(err => {
            clearTimeout(initTimeout);
            console.error('Erro ao inicializar WhatsApp:', err);
            isInitializing = false;
            socket.emit('message', 'Erro ao iniciar WhatsApp: ' + err.message);
        });
    });

    // Enviar estado atual para o novo cliente
    if (isReady) {
        socket.emit('ready', 'WhatsApp já está conectado!');
    } else if (lastQr) {
        socket.emit('qr', lastQr);
    } else if (isInitializing) {
        socket.emit('message', 'WhatsApp está inicializando...');
    } else {
        socket.emit('whatsapp-idle');
    }

    socket.on('get-chats', async () => {
        if (!isReady) return;
        try {
            const chats = await client.getChats();
            const chatData = chats.slice(0, 20).map(c => ({
                id: c.id._serialized,
                name: c.name,
                unreadCount: c.unreadCount,
                timestamp: c.timestamp
            }));
            socket.emit('chats', chatData);
        } catch (err) {
            console.error('Error fetching chats:', err);
        }
    });

    socket.on('get-history', async (chatId) => {
        try {
            const chat = await client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 20 });
            const msgData = messages.map(m => ({
                body: m.body || (m.hasMedia ? '[Mídia/Imagem/Áudio]' : '[Mensagem de Sistema]'),
                fromMe: m.fromMe,
                timestamp: new Date(m.timestamp * 1000).toLocaleTimeString()
            }));
            socket.emit('history', { chatId, messages: msgData });
        } catch (err) {
            console.error('Error fetching history:', err);
            socket.emit('history', { chatId, messages: [
                {
                    body: `[Sistema: Não foi possível sincronizar o histórico neste momento. Detalhes: ${err.message}]`,
                    fromMe: false,
                    timestamp: new Date().toLocaleTimeString()
                }
            ]});
        }
    });

    socket.on('send-message', async (data) => {
        const { number, message, chatId } = data;
        try {
            let targetId = chatId;

            if (!targetId && number) {
                const cleanNumber = number.replace(/\D/g, '');
                const numberDetails = await client.getNumberId(cleanNumber);
                if (numberDetails) {
                    targetId = numberDetails._serialized;
                }
            }

            if (targetId) {
                const sentMsg = await client.sendMessage(targetId, message);
                socket.emit('message-status', {
                    success: true,
                    chatId: targetId,
                    message: {
                        body: message,
                        fromMe: true,
                        timestamp: new Date().toLocaleTimeString()
                    }
                });
            } else {
                socket.emit('message-status', { success: false, message: 'Número inválido.' });
            }
        } catch (error) {
            console.error('Error sending message:', error);
            socket.emit('message-status', { success: false, message: 'Erro ao enviar: ' + error.message });
        }
    });
});

// Inicialização Inteligente
const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session-main-session');
if (fs.existsSync(sessionPath)) {
    console.log('[WWEB] Sessão salva detectada. Inicializando automaticamente...');
    isInitializing = true;
    client.initialize().catch(err => {
        console.error('Erro na inicialização automática:', err);
        isInitializing = false;
    });
} else {
    console.log('[WWEB] Nenhuma sessão encontrada. Aguardando comando manual do usuário.');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
