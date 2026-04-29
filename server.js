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
oracledb.fetchAsString = [oracledb.CLOB]; // Garante que CLOBs venham como string
oracledb.autoCommit = true;

// Define TNS_ADMIN globalmente na inicialização para o driver localizar tnsnames.ora e sqlnet.ora
process.env.TNS_ADMIN = oracleConfig.walletLocation;

// Cache local de mensagens para mitigar bugs do fetchMessages do whatsapp-web.js
const messageCache = {};

// Cache de Dizimistas (Telefone -> Nome) por 5 minutos para evitar overload no BD do 'get-chats'
let dizimistasContactCache = null;
let lastDizimistasCacheTime = 0;

async function getDizimistasCache() {
    if (dizimistasContactCache && (Date.now() - lastDizimistasCacheTime) < 5 * 60 * 1000) {
        return dizimistasContactCache;
    }
    let conn;
    try {
        conn = await getOracleConnection();
        const res = await conn.execute(`SELECT TELEFONE, APELIDO, NOME FROM DIZIMISTAS WHERE TELEFONE IS NOT NULL AND STATUS = 1`);
        const map = {};
        for (const r of res.rows) {
            if (!r.TELEFONE) continue;
            let cleanPhone = r.TELEFONE.replace(/\D/g, '');
            if (cleanPhone.length >= 10 && cleanPhone.length <= 11) cleanPhone = '55' + cleanPhone;
            map[cleanPhone] = r.APELIDO || r.NOME;
        }
        dizimistasContactCache = map;
        lastDizimistasCacheTime = Date.now();
        return map;
    } catch (err) {
        console.error("Erro atualizar cache de contatos:", err);
        return dizimistasContactCache || {};
    } finally {
        if (conn) await conn.close();
    }
}

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

        // Verifica se a tabela MENSAGENS existe
        const checkTableMensagens = await conn.execute(`
            SELECT table_name FROM user_tables WHERE table_name = 'MENSAGENS'
        `);

        if (checkTableMensagens.rows.length === 0) {
            console.log('Table MENSAGENS not found. Creating...');
            await conn.execute(`
                CREATE TABLE MENSAGENS (
                    ID_MENSAGENS NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    TELEFONE VARCHAR2(20),
                    TEXTO VARCHAR2(4000),
                    STATUS NUMBER DEFAULT 0,
                    RETORNO VARCHAR2(1000)
                )
            `);
            console.log('Table MENSAGENS created successfully.');
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

// Guard de processamento: evita que a mesma mensagem/evento paralelo
// dispare duas respostas simultâneas para o mesmo número.
const processingPhones = new Set();

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
                AND STATUS = 1
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
        const phone = contact.number;
        let conn;
        try {
            conn = await getOracleConnection();
            // Missas da semana a partir de hoje (próximos 7 dias)
            const result = await conn.execute(`
                SELECT ID_MISSA, TO_CHAR(TO_DATE(DATA_MISSA, 'YYYY-MM-DD'), 'DD/MM') as DATA, HORA, COMUNIDADE, CELEBRANTE 
                FROM MISSAS 
                WHERE TO_DATE(DATA_MISSA, 'YYYY-MM-DD') >= TRUNC(SYSDATE) 
                AND TO_DATE(DATA_MISSA, 'YYYY-MM-DD') < TRUNC(SYSDATE) + 7
                AND STATUS = 1
                ORDER BY DATA_MISSA, HORA
            `);

            if (result.rows.length === 0) return "Não há missas agendadas para os próximos 7 dias.";

            // Guardar no estado para a seleção
            userStates[phone] = {
                ...userStates[phone],
                flowId: 'listar_missas_selecao',
                availableMasses: result.rows
            };

            let response = "📅 *MISSAS DA SEMANA*\n\n";
            result.rows.forEach((r, idx) => {
                response += `${idx + 1} - ${r.DATA} - ${r.HORA}\n`;
            });

            response += "\nDigite *0* para menu principal\n";
            response += "Digite o *número* da missa para ver detalhes (caso tenha permissão)";
            
            return response;
        } catch (err) {
            console.error('Erro listarMissas:', err);
            return "Erro ao buscar missas. Tente novamente mais tarde.";
        } finally {
            if (conn) await conn.close();
        }
    },
    fluxoServir: async (msg, contact, userData, pMonthOffset = 0, pForced = false, pOnlyWithVacancies = null) => {
        const phone = contact.number;
        const idDizimista = userData.id;
        const nomeDizimista = userData.apelido || userData.nome;

        // Se for o mês atual, não houver offset forçado e passar do dia 15
        if (pMonthOffset === 0 && !pForced && new Date().getDate() > 15) {
            userStates[phone] = {
                ...userStates[phone],
                flowId: 'servir_escolha_mes',
                idDizimista: userData.id,
                nomeDizimista: userData.nome,
                apelidoDizimista: userData.apelido
            };
            return "O dia 15 já passou. Para qual período deseja ver as missas disponíveis?\n\n1️⃣ - Missas restantes deste mês\n2️⃣ - Missas do próximo mês\n\n*0* - Voltar ao Menu Principal";
        }

        // Recupera opção de filtro do parâmetro ou do estado salvo
        const onlyWithVacancies = pOnlyWithVacancies !== null ? pOnlyWithVacancies : userStates[phone]?.onlyWithVacancies;

        if (onlyWithVacancies === undefined || onlyWithVacancies === null) {
            userStates[phone] = {
                ...userStates[phone],
                flowId: 'servir_escolha_filtro',
                idDizimista: userData.id,
                nomeDizimista: userData.nome,
                apelidoDizimista: userData.apelido,
                monthOffset: pMonthOffset
            };
            return "Como você deseja visualizar as missas?\n\n1️⃣ - *Ver Todas* as missas\n2️⃣ - *Somente com Vagas* (ou onde já participo)\n\n*0* - Voltar ao Menu Principal";
        }

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
                        WHERE ms2.ID_MISSA = m.ID_MISSA AND ms2.ID_PASTORAL = mp.ID_PASTORAL
                        AND d.STATUS = 1) as SERVOS_ATUAIS
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

            // Aplicar filtro se solicitado
            let finalRows = resMissas.rows;
            if (onlyWithVacancies) {
                finalRows = resMissas.rows.filter(r => (r.QUANTIDADE_SERVOS - r.ATUAIS > 0) || r.JA_INSCRITO > 0);
            }

            if (finalRows.length === 0) {
                return `Olá ${nomeDizimista}! Não há missas com vagas abertas para suas pastorais neste período.`;
            }

            // Guardar no estado para a seleção
            userStates[phone] = {
                flowId: 'servir_selecao',
                idDizimista,
                nomeDizimista: userData.nome,
                apelidoDizimista: userData.apelido,
                monthOffset: pMonthOffset,
                onlyWithVacancies: onlyWithVacancies,
                availableMasses: finalRows
            };

            console.log(`[FLOW] Oferecendo ${finalRows.length} missas para ${nomeDizimista} (Mês Offset: ${pMonthOffset}, Filtro Vagas: ${onlyWithVacancies})`);

            let response = `Olá *${nomeDizimista}*! 👋\nEscolha em qual missa você deseja servir:\n\n`;
            finalRows.forEach((r, idx) => {
                let statusMsg = "";
                let vagasRestantes = r.QUANTIDADE_SERVOS - r.ATUAIS;

                const linhasVagas = [];
                for (let i = 0; i < vagasRestantes; i++) {
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
    fluxoCancelarServir: async (msg, contact, userData) => {
        const phone = contact.number;
        const idDizimista = userData.id;
        const nomeDizimista = userData.apelido || userData.nome;

        let conn;
        try {
            conn = await getOracleConnection();

            // Buscar Missas que o usuário está inscrito (sem restrição de mês, apenas de hoje em diante)
            const resMissas = await conn.execute(`
                SELECT m.ID_MISSA, TO_CHAR(TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD'), 'DD/MM') as DATA, m.HORA, m.COMUNIDADE, 
                       ms.ID_PASTORAL, p.NOME as PASTORAL_NOME
                FROM MISSA_SERVOS ms
                JOIN MISSAS m ON ms.ID_MISSA = m.ID_MISSA
                JOIN PASTORAIS p ON ms.ID_PASTORAL = p.ID_PASTORAL
                WHERE ms.ID_DIZIMISTA = :idDizimista
                AND TO_DATE(m.DATA_MISSA, 'YYYY-MM-DD') >= TRUNC(SYSDATE)
                ORDER BY m.DATA_MISSA, m.HORA
            `, { idDizimista });

            if (resMissas.rows.length === 0) {
                return `Olá ${nomeDizimista}! Não encontrei nenhuma missa em que você esteja escalado(a) neste período para cancelar.`;
            }

            // Guardar no estado para a seleção de cancelamento
            userStates[phone] = {
                flowId: 'cancelar_selecao',
                idDizimista,
                nomeDizimista: userData.nome,
                apelidoDizimista: userData.apelido,
                availableMasses: resMissas.rows
            };

            let response = `Olá *${nomeDizimista}*! 👋\nVocê está escalado(a) nas seguintes missas.\nEscolha o número da missa que deseja *CANCELAR* sua participação:\n\n`;
            resMissas.rows.forEach((r, idx) => {
                response += `*${idx + 1}* - ${r.DATA} às ${r.HORA}\n📍 ${r.COMUNIDADE}\n🛠 Pastoral: *${r.PASTORAL_NOME}*\n\n`;
            });
            response += "*0* - Voltar ao Menu Anterior\n\nResponda com o *NÚMERO* da missa que deseja desmarcar.";
            return response;

        } catch (err) {
            console.error('Erro fluxoCancelarServir:', err);
            return "Erro ao processar sua solicitação de consulta.";
        } finally {
            if (conn) await conn.close();
        }
    }
};

// ============================================================
// UTILITÁRIOS DE CADASTRO
// ============================================================

/**
 * Valida CPF usando o algoritmo dos dígitos verificadores (módulo 11).
 * Aceita CPF com ou sem formatação (pontos/traço).
 */
function validarCPF(cpf) {
    const c = cpf.replace(/\D/g, '');
    if (c.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(c)) return false; // CPFs com todos os dígitos iguais
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += parseInt(c[i]) * (10 - i);
    let r = (soma * 10) % 11;
    if (r === 10 || r === 11) r = 0;
    if (r !== parseInt(c[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += parseInt(c[i]) * (11 - i);
    r = (soma * 10) % 11;
    if (r === 10 || r === 11) r = 0;
    return r === parseInt(c[10]);
}

/**
 * Formata CPF para o padrão 000.000.000-00
 */
function formatarCPF(cpf) {
    const c = (cpf || '').replace(/\D/g, '');
    if (c.length !== 11) return c;
    return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9, 11)}`;
}

/**
 * Gera uma string fonética baseada nas palavras do nome (cada palavra > 2 chars).
 * Utiliza a função SOUNDEX do Oracle para cada palavra.
 */
async function generatePhonetics(name, conn) {
    const words = (name || '').toString().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return "";

    // Constrói a query: SELECT SOUNDEX(:1) as P1, SOUNDEX(:2) as P2... FROM DUAL
    const selectCols = words.map((_, i) => `SOUNDEX(:${i + 1}) as P${i + 1}`).join(", ");
    const query = `SELECT ${selectCols} FROM DUAL`;

    try {
        const result = await conn.execute(query, words);
        if (result.rows && result.rows.length > 0) {
            const row = result.rows[0];
            return Object.values(row).filter(v => v).join(" ");
        }
    } catch (err) {
        console.error('Erro em generatePhonetics:', err);
    }
    return "";
}


/**
 * Inicia o fluxo de cadastro: informa que o número não está cadastrado
 * e solicita o CPF para busca.
 */
async function iniciarFluxoCadastro(msg, phone) {
    const displayNumber = phone.replace(/^55/, '');
    userStates[phone] = { flowId: 'cadastro_cpf' };
    await msg.reply(
        `Olá! 👋 O número *${displayNumber}* não está cadastrado em nossa paróquia.\n\n` +
        `Para verificarmos se você já tem um cadastro, por favor, informe o seu *CPF* (apenas números):`
    );
    console.log(`[CADASTRO] Iniciando fluxo para o número (não encontrado): ${phone}`);
}

/**
 * Finaliza o cadastro: grava DIZIMISTAS, envia boas-vindas e inicia identificação pastoral.
 */
async function finalizarCadastro(msg, phone) {
    const dados = userStates[phone];
    let conn;
    try {
        conn = await getOracleConnection();

        // --- 1. Grava DIZIMISTAS ---
        const telNacional = phone.replace(/^55/, '');
        const fonetica = await generatePhonetics(dados.nome, conn);
        console.log(`[CADASTRO] Gerando registro para ${dados.nome}. Fonética: "${fonetica}", CPF: ${dados.cpf}`);

        await conn.execute(`
            INSERT INTO DIZIMISTAS (NOME, FONETICA, CPF, TELEFONE, EMAIL, CEP, ENDERECO, DATA_NASCIMENTO, STATUS)
            VALUES (:nome, :fonetica, :cpf, :telefone, :email, :cep, :endereco,
                    TO_DATE(:nascimento, 'DD/MM/YYYY'), 1)
        `, {
            nome: dados.nome,
            fonetica: fonetica,
            cpf: formatarCPF(dados.cpf),
            telefone: telNacional,
            email: dados.email,
            cep: dados.cep.replace(/\D/g, ''),
            endereco: dados.endereco,
            nascimento: dados.nascimento
        }, { autoCommit: true });

        // Recupera o ID gerado (usando REGEXP_REPLACE para ser robusto com a formatação)
        const resId = await conn.execute(`
            SELECT ID_DIZIMISTA FROM DIZIMISTAS 
            WHERE REGEXP_REPLACE(CPF, '[^0-9]', '') = :cpf
            AND STATUS = 1
        `, { cpf: dados.cpf.replace(/\D/g, '') });

        if (resId.rows.length === 0) {
            console.error(`[CADASTRO] Erro crítico: Registro inserido mas não encontrado para o CPF ${dados.cpf}`);
            throw new Error("Falha ao recuperar ID do dizimista cadastrado.");
        }
        const idDizimista = resId.rows[0].ID_DIZIMISTA;

        // Invalida cache de contatos para incluir o novo dizimista
        dizimistasContactCache = null;

        console.log(`[CADASTRO] Dizimista "${dados.nome}" criado com sucesso. ID_DIZIMISTA: ${idDizimista}`);

        // --- 2. Boas Vindas ---
        const hour = new Date().getHours();
        let saudacao = 'Boa noite';
        if (hour >= 5 && hour < 12) saudacao = 'Bom dia';
        else if (hour >= 12 && hour < 18) saudacao = 'Boa tarde';
        const primeiroNome = dados.nome.split(' ')[0];

        await msg.reply(
            `✅ *Cadastro realizado com sucesso!* ${saudacao}, *${primeiroNome}*! 🙏\n\n` +
            `Seja bem-vindo(a) à nossa paróquia!`
        );

        // --- 3. Segue o fluxo normal de identificação: Pastoral ---
        // Como o cadastro acabou de ser feito, sabemos que não tem pastoral vinculada.
        await new Promise(r => setTimeout(r, 1500));

        userStates[phone] = {
            flowId: 'pastoral_participar',
            idDizimista: idDizimista,
            nomeDizimista: dados.nome,
            apelidoDizimista: primeiroNome
        };

        await msg.reply(
            `Notamos que você ainda não está vinculado a nenhuma pastoral no sistema.\n\n` +
            `Você participa de alguma pastoral na paróquia?\n\n` +
            `Digite *S* para sim ou *N* para não.`
        );

    } catch (err) {
        console.error('[CADASTRO] Erro ao finalizar cadastro:', err);
        await msg.reply(
            `⚠️ Ocorreu um erro ao gravar seu cadastro: ${err.message || 'Erro desconhecido'}\n\n` +
            `Por favor, entre em contato com a secretaria para regularização.`
        );
        delete userStates[phone];
    } finally {
        if (conn) await conn.close();
    }
}

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
            WHERE TELEFONE IS NOT NULL AND STATUS = 1 AND ROWNUM <= 500
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
        protocolTimeout: 120000, // 120s — evita ProtocolError timed out sob carga
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

    // Inicia a rotina de busca de mensagens programadas
    startMessageRoutine();
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
    let chat, contact;
    try {
        chat = await msg.getChat();
        contact = await msg.getContact();
    } catch (initErr) {
        console.error('[MSG] Erro ao obter chat/contact (Puppeteer timeout?):', initErr.message);
        return; // Abandona o processamento desta mensagem
    }

    try {
        const chatId = chat.id._serialized;
        if (!messageCache[chatId]) messageCache[chatId] = [];
        messageCache[chatId].push({
            body: msg.body || (msg.hasMedia ? '[Mídia/Imagem/Áudio]' : '[Mensagem de Sistema]'),
            fromMe: msg.fromMe,
            timestamp: new Date(msg.timestamp * 1000).toLocaleTimeString()
        });
        if (messageCache[chatId].length > 50) messageCache[chatId].shift(); // Mantém as ultimas 50
    } catch (e) { }

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

        // Guard: ignora mensagem se este telefone já está sendo processado (evita duplicidade)
        if (processingPhones.has(phone)) {
            console.log(`[GUARD] Mensagem de ${phone} ignorada — processamento já em andamento.`);
            return;
        }
        processingPhones.add(phone);

        try {
            // --- 0. COMANDOS GLOBAIS DE NAVEGAÇÃO E RESET ---
            // Palavras-chave que reiniciam tudo (case-insensitive, sem acentos)
            const textNorm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
            const RESET_KEYWORDS = ['sair', 'recomecar', 'cancelar', 'reiniciar', 'inicio'];
            const isReset = RESET_KEYWORDS.includes(textNorm);

            // Detecção de entrada incoerente: só pontuação, ponto isolado, ou menos de 2 chars sem sentido
            const isIncoerente = /^[.\-_!?,;:@#$%^&*()\s]+$/.test(text) ||
                (text.length <= 2 && !/^\d+$/.test(text) && text !== 's' && text !== 'n');

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

            if (isReset) {
                console.log(`[RESET] Usuário ${phone} solicitou reset com: "${text}"`);
                const currentState = userStates[phone];
                delete userStates[phone]; // Limpa todo o estado atual
                await msg.reply(
                    `🔄 *Conversa reiniciada!*\n\n` +
                    `Envie qualquer mensagem para começarmos novamente. 😊`
                );
                return;
            }


            let state = userStates[phone];

            if (!state) {
                // Identifica o usuário logo no primeiro contato
                const userData = await internalFunctions.buscarDizimistaPorTelefone(phone);

                if (!userData) {
                    await iniciarFluxoCadastro(msg, phone);
                    return;
                }

                // --- Verifica se o dizimista já pertence a alguma pastoral ---
                let connPasCheck;
                let temPastoral = false;
                try {
                    connPasCheck = await getOracleConnection();
                    const resPas = await connPasCheck.execute(
                        `SELECT 1 FROM DIZIMISTA_PASTORAL dp 
                         JOIN DIZIMISTAS d ON dp.ID_DIZIMISTA = d.ID_DIZIMISTA
                         WHERE d.ID_DIZIMISTA = :id AND d.STATUS = 1 AND ROWNUM = 1`,
                        { id: userData.id }
                    );
                    temPastoral = resPas.rows.length > 0;
                } catch (e) {
                    console.error('[PASTORAL-CHECK] Erro ao verificar pastoral:', e);
                    temPastoral = true; // em caso de erro, deixa passar para o menu
                } finally {
                    if (connPasCheck) await connPasCheck.close();
                }

                // Saudação baseada no horário
                const hour = new Date().getHours();
                let saudacao = 'Boa noite';
                if (hour >= 5 && hour < 12) saudacao = 'Bom dia';
                else if (hour >= 12 && hour < 18) saudacao = 'Boa tarde';
                const primeiroNome = (userData.apelido || userData.nome).split(' ')[0];

                if (!temPastoral) {
                    // Sem pastoral → perguntar se participa de alguma
                    userStates[phone] = {
                        flowId: 'pastoral_participar',
                        idDizimista: userData.id,
                        nomeDizimista: userData.nome,
                        apelidoDizimista: userData.apelido
                    };
                    await msg.reply(
                        `*${saudacao}, ${primeiroNome}!* 🙏\n\n` +
                        `Notamos que você ainda não está vinculado a nenhuma pastoral no sistema.\n\n` +
                        `Você participa de alguma pastoral na paróquia?\n\n` +
                        `Digite *S* para sim ou *N* para não.`
                    );
                    console.log(`[PASTORAL] Dizimista ${userData.nome} sem pastoral — perguntando participação.`);
                    return;
                }

                // Com pastoral → comportamento normal
                const mainFlow = chatFlows['main_menu'];
                if (!mainFlow) {
                    await msg.reply(`*Olá, ${userData.nome}!* 🙏\nSeja bem-vindo. No momento nosso menu está em manutenção.`);
                    return;
                }

                userStates[phone] = {
                    flowId: 'main_menu',
                    idDizimista: userData.id,
                    nomeDizimista: userData.nome,
                    apelidoDizimista: userData.apelido
                };

                await msg.reply(`*${saudacao}, ${primeiroNome}!* 🙏\n${mainFlow.message}`);
                console.log(`[FLOW-DB] Menu Principal enviado para ${userData.nome}`);
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

            // --- Detecção de entrada incoerente em fluxos multi-passo ---
            // Só aplica quando o usuário está num fluxo de cadastro ou pastoral (não no menu)
            const multiStepFlows = [
                'cadastro_cpf', 'cadastro_confirmar_telefone', 'cadastro_nome',
                'cadastro_cpf_novo', 'cadastro_email', 'cadastro_cep',
                'cadastro_endereco', 'cadastro_nascimento',
                'pastoral_participar', 'pastoral_selecao'
            ];
            if (isIncoerente && multiStepFlows.includes(state.flowId)) {
                console.log(`[INCOERENTE] ${phone} digitou entrada inválida no fluxo ${state.flowId}: "${text}"`);
                await msg.reply(
                    `⚠️ Não entendi sua mensagem.\n\n` +
                    `• Digite *CANCELAR* para recomeçar do início\n` +
                    `• Digite *MENU* para ir ao menu principal\n` +
                    `• Ou responda a pergunta anterior corretamente.`
                );
                return;
            }

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
            } else if (state.flowId === 'servir_escolha_mes') {
                console.log(`[STATE] Usuário ${phone} decidindo mês para servir: ${text}`);

                if (text === '1') {
                    const result = await internalFunctions.fluxoServir(msg, contact, { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista }, 0, true);
                    await msg.reply(result);
                } else if (text === '2') {
                    const result = await internalFunctions.fluxoServir(msg, contact, { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista }, 1, true);
                    await msg.reply(result);
                } else if (text === '0') {
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
                } else {
                    await msg.reply("Opção inválida. Digite *1* para este mês, *2* para o próximo mês ou *0* para voltar.");
                }
            } else if (state.flowId === 'servir_escolha_filtro') {
                console.log(`[STATE] Usuário ${phone} decidindo filtro de missas: ${text}`);
                if (text === '1' || text === '2') {
                    const onlyWithVacancies = (text === '2');
                    // Salva no estado para manter o parâmetro ao repetir a lista
                    state.onlyWithVacancies = onlyWithVacancies;
                    const result = await internalFunctions.fluxoServir(msg, contact,
                        { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista },
                        state.monthOffset || 0, true, onlyWithVacancies);
                    await msg.reply(result);
                } else if (text === '0') {
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
                } else {
                    await msg.reply("Opção inválida. Digite *1* para Ver Todas, *2* para Somente com Vagas ou *0* para voltar ao menu.");
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

                    // Verificação em cache: já está inscrito
                    if (selectedMass.JA_INSCRITO > 0) {
                        await msg.reply("Você já está inscrito para servir nesta missa! Escolha outra opção ou digite *0* para voltar.");
                        return;
                    }

                    // Efetivar candidatura
                    let conn;
                    try {
                        conn = await getOracleConnection();

                        // --- Validação em tempo real (anti-race condition) ---
                        // Checa vagas ATUAIS diretamente no banco antes de inserir
                        const vagasCheck = await conn.execute(`
                        SELECT COUNT(*) as ATUAIS, mp.QUANTIDADE_SERVOS
                        FROM MISSA_SERVOS ms
                        JOIN MISSA_PASTORAL mp ON ms.ID_MISSA = mp.ID_MISSA AND ms.ID_PASTORAL = mp.ID_PASTORAL
                        WHERE ms.ID_MISSA = :m AND ms.ID_PASTORAL = :p
                        GROUP BY mp.QUANTIDADE_SERVOS
                    `, { m: selectedMass.ID_MISSA, p: selectedMass.ID_PASTORAL });

                        const vagasRow = vagasCheck.rows[0];
                        const atuaisDB = vagasRow ? vagasRow.ATUAIS : 0;
                        const maxServos = vagasRow ? vagasRow.QUANTIDADE_SERVOS : selectedMass.QUANTIDADE_SERVOS;

                        if (atuaisDB >= maxServos) {
                            // Vaga foi preenchida por outro servo enquanto o usuário escolhia
                            console.log(`[RACE] Vaga da missa ${selectedMass.ID_MISSA} esgotada em tempo real para ${phone}.`);
                            await msg.reply(
                                `⚠️ Que pena! A vaga na missa de *${selectedMass.DATA} às ${selectedMass.HORA}* acabou de ser preenchida por outro servo.` +
                                `\n\nAqui está a lista atualizada para uma nova escolha:`
                            );
                            // Reexibe lista atualizada
                            const listaAtualizada = await internalFunctions.fluxoServir(
                                msg, contact,
                                { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista },
                                state.monthOffset || 0
                            );
                            await msg.reply(listaAtualizada);
                            return;
                        }

                        // Verificar duplicidade para este dizimista
                        const checkDup = await conn.execute(`
                        SELECT 1 FROM MISSA_SERVOS WHERE ID_MISSA = :m AND ID_DIZIMISTA = :d
                    `, { m: selectedMass.ID_MISSA, d: state.idDizimista });

                        if (checkDup.rows.length > 0) {
                            await msg.reply("Você já está inscrito para servir nesta missa! Escolha outra opção ou digite *0* para voltar.");
                            return;
                        }

                        // --- INSERT ---
                        await conn.execute(`
                        INSERT INTO MISSA_SERVOS (ID_MISSA, ID_DIZIMISTA, ID_PASTORAL) 
                        VALUES (:m, :d, :p)
                    `, {
                            m: selectedMass.ID_MISSA,
                            d: state.idDizimista,
                            p: selectedMass.ID_PASTORAL
                        });

                        await msg.reply(`✅ Confirmado! Você foi escalado para servir na missa de *${selectedMass.DATA} às ${selectedMass.HORA}*. Deus abençoe! 🙏`);

                        // Reexibe lista atualizada para possível nova inscrição
                        await new Promise(r => setTimeout(r, 800));
                        const listaAtualizada = await internalFunctions.fluxoServir(
                            msg, contact,
                            { id: state.idDizimista, nome: state.nomeDizimista, apelido: state.apelidoDizimista },
                            state.monthOffset || 0
                        );
                        await msg.reply(listaAtualizada);

                    } catch (err) {
                        console.error('Erro ao salvar missa_servos:', err);
                        await msg.reply("Houve um erro ao confirmar sua escala. Tente novamente.");
                        delete userStates[phone];
                    } finally {
                        if (conn) await conn.close();
                    }
                } else {
                    await msg.reply("Opção inválida. Por favor, escolha o número correspondente à missa na lista acima.");
                }
            } else if (state.flowId === 'listar_missas_selecao') {
                console.log(`[STATE] Usuário ${phone} selecionando missa para detalhes: ${text}`);

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

                const index = parseInt(text) - 1;
                if (!isNaN(index) && state.availableMasses && state.availableMasses[index]) {
                    const selectedMass = state.availableMasses[index];
                    let conn;
                    try {
                        conn = await getOracleConnection();

                        // 1. Verificar permissão (Coordenador ou Usuário do Sistema)
                        const resPerm = await conn.execute(`
                            SELECT 1 FROM (
                                SELECT PAPEL FROM DIZIMISTA_PASTORAL WHERE ID_DIZIMISTA = :id AND PAPEL = 'C'
                                UNION
                                SELECT 1 FROM USUARIOS WHERE ID_DIZIMISTA = :id
                            ) WHERE ROWNUM = 1
                        `, { id: state.idDizimista });

                        if (resPerm.rows.length === 0) {
                            await msg.reply("Você não tem permissão para visualizar a escala detalhada desta missa. Entre em contato com seu coordenador.");
                            return;
                        }

                        // 2. Buscar detalhes da missa (incluindo descrição se existir)
                        const resMissa = await conn.execute(`
                            SELECT COMUNIDADE, CELEBRANTE, 
                                   TO_CHAR(TO_DATE(DATA_MISSA, 'YYYY-MM-DD'), 'DD/MM/YYYY') as DATA_FMT,
                                   HORA 
                            FROM MISSAS WHERE ID_MISSA = :id
                        `, { id: selectedMass.ID_MISSA });

                        const mData = resMissa.rows[0];

                        // 3. Buscar Pastorais e Servos
                        const resServos = await conn.execute(`
                            SELECT p.NOME as PASTORAL, NVL(d.APELIDO, d.NOME) as SERVO
                            FROM MISSA_SERVOS ms
                            JOIN PASTORAIS p ON ms.ID_PASTORAL = p.ID_PASTORAL
                            JOIN DIZIMISTAS d ON ms.ID_DIZIMISTA = d.ID_DIZIMISTA
                            WHERE ms.ID_MISSA = :id
                            ORDER BY p.NOME, d.NOME
                        `, { id: selectedMass.ID_MISSA });

                        let response = `📍 *DETALHES DA MISSA*\n\n`;
                        response += `📅 *Data:* ${mData.DATA_FMT} às ${mData.HORA}\n`;
                        response += `⛪ *Comunidade:* ${mData.COMUNIDADE}\n`;
                        if (mData.CELEBRANTE) response += `👤 *Celebrante:* ${mData.CELEBRANTE}\n`;
                        response += `\n📋 *ESCALA DE SERVOS:*\n`;

                        if (resServos.rows.length === 0) {
                            response += "_Nenhum servo escalado ainda._\n";
                        } else {
                            let currentPastoral = "";
                            resServos.rows.forEach(s => {
                                if (s.PASTORAL !== currentPastoral) {
                                    currentPastoral = s.PASTORAL;
                                    response += `\n🛠 *${currentPastoral}:*\n`;
                                }
                                response += `• ${s.SERVO}\n`;
                            });
                        }

                        response += "\nDigite *0* para voltar ao menu ou outro número para ver outra missa.";
                        await msg.reply(response);

                    } catch (err) {
                        console.error('Erro ao buscar detalhes da missa:', err);
                        await msg.reply("Houve um erro ao buscar os detalhes da missa. Tente novamente.");
                    } finally {
                        if (conn) await conn.close();
                    }
                } else {
                    await msg.reply("Opção inválida. Por favor, escolha o número correspondente à missa na lista.");
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
                            WHERE dp.ID_PASTORAL = :p AND dp.PAPEL = 'C' AND d.STATUS = 1
                        `, { p: selectedMass.ID_PASTORAL });

                            // Enfileirar notificação para coordenadores na tabela MENSAGENS
                            for (const coord of resCoord.rows) {
                                if (coord.TELEFONE) {
                                    const sms = `O servo ${state.apelidoDizimista || state.nomeDizimista} acabou de cancelar sua participação na missa do dia ${selectedMass.DATA} das ${selectedMass.HORA}`;

                                    await conn.execute(`
                                    INSERT INTO MENSAGENS (TELEFONE, TEXTO, STATUS) 
                                    VALUES (:tel, :txt, 0)
                                `, {
                                        tel: coord.TELEFONE,
                                        txt: sms
                                    });
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
            } else if (state.flowId === 'cadastro_cpf') {
                // ── Etapa: Usuário informou CPF para busca ──
                const cpfDigitado = text.replace(/\D/g, '');
                if (cpfDigitado.length !== 11) {
                    await msg.reply('CPF inválido. Por favor, informe os *11 dígitos* do seu CPF (apenas números):');
                    return;
                }
                let conn;
                try {
                    conn = await getOracleConnection();
                    const resCPF = await conn.execute(
                        `SELECT ID_DIZIMISTA, NOME, TELEFONE FROM DIZIMISTAS WHERE REGEXP_REPLACE(CPF,'[^0-9]','') = :cpf AND STATUS = 1`,
                        { cpf: cpfDigitado }
                    );
                    if (resCPF.rows.length > 0) {
                        const diz = resCPF.rows[0];
                        const telAtual = diz.TELEFONE ? diz.TELEFONE.replace(/\D/g, '') : '';
                        userStates[phone] = {
                            flowId: 'cadastro_confirmar_telefone',
                            idDizimista: diz.ID_DIZIMISTA,
                            nomeDizimista: diz.NOME
                        };
                        await msg.reply(
                            `✅ Encontramos um cadastro para o CPF informado!\n\n` +
                            `*Nome:* ${diz.NOME}\n` +
                            `*Telefone cadastrado:* ${telAtual || 'não informado'}\n\n` +
                            `Deseja atualizar o telefone cadastrado para o número atual que está sendo usado?\n\n` +
                            `Digite *S* para confirmar ou *N* para cancelar.`
                        );
                    } else {
                        // CPF não encontrado → valida dígitos antes de abrir cadastro
                        if (!validarCPF(cpfDigitado)) {
                            await msg.reply(
                                `❌ O CPF *${cpfDigitado}* é inválido (dígitos verificadores incorretos).\n\n` +
                                `Por favor, verifique o número e informe novamente o seu *CPF* (apenas 11 dígitos):`
                            );
                            // Mantém o flowId 'cadastro_cpf' para nova tentativa
                            return;
                        }
                        // CPF válido e não cadastrado → inicia cadastro completo
                        userStates[phone] = { flowId: 'cadastro_nome', cpf: cpfDigitado };
                        await msg.reply(
                            `Não encontramos nenhum cadastro com esse CPF.\n\n` +
                            `Vamos criar seu cadastro! 📝\n\n` +
                            `Por favor, informe seu *Nome Completo*:`
                        );
                    }
                } catch (err) {
                    console.error('[CADASTRO] Erro ao buscar CPF:', err);
                    await msg.reply('Ocorreu um erro ao buscar o CPF. Tente novamente mais tarde.');
                    delete userStates[phone];
                } finally {
                    if (conn) await conn.close();
                }

            } else if (state.flowId === 'cadastro_confirmar_telefone') {
                // ── Etapa: Usuário responde S/N para atualizar telefone ──
                const resposta = text.toLowerCase().trim();
                if (resposta === 's' || resposta === 'sim') {
                    let conn;
                    try {
                        conn = await getOracleConnection();
                        const telNacional = phone.replace(/^55/, '');
                        await conn.execute(
                            `UPDATE DIZIMISTAS SET TELEFONE = :tel WHERE ID_DIZIMISTA = :id`,
                            { tel: telNacional, id: state.idDizimista }
                        );
                        console.log(`[CADASTRO] Telefone atualizado para o dizimista ID ${state.idDizimista}`);
                        // Invalida cache de contatos
                        dizimistasContactCache = null;

                        const mainFlow = chatFlows['main_menu'];
                        const hour = new Date().getHours();
                        let saudacao = 'Boa noite';
                        if (hour >= 5 && hour < 12) saudacao = 'Bom dia';
                        else if (hour >= 12 && hour < 18) saudacao = 'Boa tarde';

                        await msg.reply(
                            `✅ Telefone atualizado com sucesso! ${saudacao}, *${state.nomeDizimista}*! 🙏\n\n` +
                            (mainFlow ? mainFlow.message : 'Cadastro vinculado. Use *menu* para ver as opções.')
                        );
                        userStates[phone] = {
                            flowId: 'main_menu',
                            idDizimista: state.idDizimista,
                            nomeDizimista: state.nomeDizimista,
                            apelidoDizimista: state.nomeDizimista
                        };
                    } catch (err) {
                        console.error('[CADASTRO] Erro ao atualizar telefone:', err);
                        await msg.reply('Houve um erro ao atualizar o telefone. Tente novamente mais tarde.');
                        delete userStates[phone];
                    } finally {
                        if (conn) await conn.close();
                    }
                } else if (resposta === 'n' || resposta === 'nao' || resposta === 'não') {
                    delete userStates[phone];
                    await msg.reply(
                        `Tudo bem! Para atualizar o telefone no seu cadastro, por favor entre em contato com o coordenador responsável.\n\n` +
                        `📞 Você pode tentar novamente digitando qualquer mensagem após a atualização do seu cadastro.`
                    );
                } else {
                    await msg.reply('Por favor, responda apenas *S* (sim) ou *N* (não).');
                }

            } else if (state.flowId === 'cadastro_nome') {
                // ── Etapa 1: Nome Completo ──
                const nomeTrimmed = msg.body.trim();
                if (nomeTrimmed.split(/\s+/).length < 2) {
                    await msg.reply('Por favor, informe seu *Nome Completo* (com ao menos nome e sobrenome):');
                    return;
                }
                userStates[phone].nome = nomeTrimmed;
                userStates[phone].flowId = 'cadastro_cpf_novo';
                // Verifica se o CPF já foi capturado na etapa anterior (re-uso do dado)
                if (userStates[phone].cpf) {
                    // CPF já coletado, pula para e-mail
                    userStates[phone].flowId = 'cadastro_email';
                    await msg.reply(`Ótimo, *${nomeTrimmed.split(' ')[0]}*! 😊\n\nAgora informe seu *e-mail*:`);
                } else {
                    await msg.reply(`Ótimo, *${nomeTrimmed.split(' ')[0]}*! 😊\n\nAgora informe seu *CPF* (apenas números):`);
                }

            } else if (state.flowId === 'cadastro_cpf_novo') {
                // ── Etapa 2: CPF com validação completa ──
                const cpfDigitado = msg.body.replace(/\D/g, '');
                if (!validarCPF(cpfDigitado)) {
                    await msg.reply(
                        '❌ CPF inválido! Por favor, verifique os números e tente novamente.\n\n' +
                        'Informe seu *CPF* (apenas os 11 dígitos):'
                    );
                    return;
                }
                userStates[phone].cpf = cpfDigitado;
                userStates[phone].flowId = 'cadastro_email';
                await msg.reply('CPF validado! ✅\n\nAgora informe seu *e-mail*:');

            } else if (state.flowId === 'cadastro_email') {
                // ── Etapa 3: E-mail ──
                const email = msg.body.trim();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    await msg.reply('E-mail inválido. Por favor, informe um *e-mail* válido (ex: joao@gmail.com):');
                    return;
                }
                userStates[phone].email = email;
                userStates[phone].flowId = 'cadastro_cep';
                await msg.reply('E-mail registrado! ✅\n\nAgora informe seu *CEP* (apenas números):');

            } else if (state.flowId === 'cadastro_cep') {
                // ── Etapa 4: CEP ──
                const cep = msg.body.replace(/\D/g, '');
                if (cep.length !== 8) {
                    await msg.reply('CEP inválido. Por favor, informe os *8 dígitos* do seu CEP (apenas números):');
                    return;
                }
                userStates[phone].cep = cep;
                userStates[phone].flowId = 'cadastro_endereco';
                await msg.reply('CEP registrado! ✅\n\nAgora informe seu *Endereço completo* (Rua, número, bairro):');

            } else if (state.flowId === 'cadastro_endereco') {
                // ── Etapa 5: Endereço ──
                const endereco = msg.body.trim();
                if (endereco.length < 5) {
                    await msg.reply('Endereço muito curto. Por favor, informe o *Endereço completo* (Rua, número, bairro):');
                    return;
                }
                userStates[phone].endereco = endereco;
                userStates[phone].flowId = 'cadastro_nascimento';
                await msg.reply('Endereço registrado! ✅\n\nPor último, informe sua *Data de Nascimento* no formato *DD/MM/AAAA*:');

            } else if (state.flowId === 'cadastro_nascimento') {
                // ── Etapa 6: Data de Nascimento ──
                const dataNasc = msg.body.trim();
                if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dataNasc)) {
                    await msg.reply('Data inválida. Por favor, informe no formato *DD/MM/AAAA* (ex: 25/04/1990):');
                    return;
                }
                // Valida se é uma data real
                const [dd, mm, yyyy] = dataNasc.split('/').map(Number);
                const dataObj = new Date(yyyy, mm - 1, dd);
                if (dataObj.getFullYear() !== yyyy || dataObj.getMonth() !== mm - 1 || dataObj.getDate() !== dd) {
                    await msg.reply('Data inexistente. Por favor, informe uma *Data de Nascimento* válida (ex: 25/04/1990):');
                    return;
                }
                userStates[phone].nascimento = dataNasc;
                // Informa que está processando
                await msg.reply('Perfeito! ✨ Aguarde um momento, estamos finalizando seu cadastro...');
                await finalizarCadastro(msg, phone);

            } else if (state.flowId === 'pastoral_participar') {
                // ── Pergunta se participa de pastoral ──
                const resposta = text.toLowerCase().trim();
                if (resposta === 's' || resposta === 'sim') {
                    // Lista as pastorais cadastradas
                    let conn;
                    try {
                        conn = await getOracleConnection();
                        const resPast = await conn.execute(
                            `SELECT ID_PASTORAL, NOME, AUTOCADASTRO FROM PASTORAIS WHERE STATUS = 1 ORDER BY NOME ASC`
                        );
                        if (resPast.rows.length === 0) {
                            await msg.reply(
                                'No momento não há pastorais cadastradas no sistema.\n\n' +
                                'Por favor, entre em contato com a secretaria para regularizar seu cadastro.'
                            );
                            // Vai ao menu mesmo sem pastoral
                            const mainFlow = chatFlows['main_menu'];
                            if (mainFlow) {
                                userStates[phone] = { flowId: 'main_menu', idDizimista: state.idDizimista, nomeDizimista: state.nomeDizimista, apelidoDizimista: state.apelidoDizimista };
                                await msg.reply(mainFlow.message);
                            }
                            return;
                        }

                        userStates[phone] = {
                            flowId: 'pastoral_selecao',
                            idDizimista: state.idDizimista,
                            nomeDizimista: state.nomeDizimista,
                            apelidoDizimista: state.apelidoDizimista,
                            pastoraisDisponiveis: resPast.rows
                        };

                        let resp = `*Pastorais da Paróquia* 🙏\n\nEscolha o *número* da pastoral em que você participa:\n\n`;
                        resPast.rows.forEach((p, idx) => {
                            const icone = p.AUTOCADASTRO === 1 ? '✅' : '💬';
                            resp += `*${idx + 1}* — ${p.NOME} ${icone}\n`;
                        });
                        resp += `\n✅ Entrada imediata  |  💬 Sujeito a aprovação do coordenador\n\n*0* — Não participo de nenhuma`;
                        await msg.reply(resp);

                    } catch (err) {
                        console.error('[PASTORAL] Erro ao listar pastorais:', err);
                        await msg.reply('Erro ao buscar pastorais. Tente novamente mais tarde.');
                    } finally {
                        if (conn) await conn.close();
                    }
                } else if (resposta === 'n' || resposta === 'nao' || resposta === 'não') {
                    // Não participa → vai ao menu principal
                    const mainFlow = chatFlows['main_menu'];
                    userStates[phone] = { flowId: 'main_menu', idDizimista: state.idDizimista, nomeDizimista: state.nomeDizimista, apelidoDizimista: state.apelidoDizimista };
                    await msg.reply(
                        'Tudo bem! Quando quiser se vincular a uma pastoral, fale com o coordenador.\n\n' +
                        (mainFlow ? mainFlow.message : '_Digite *menu* para ver as opções._')
                    );
                } else {
                    await msg.reply('Por favor, responda apenas *S* (sim) ou *N* (não).');
                }

            } else if (state.flowId === 'pastoral_selecao') {
                // ── Usuário escolheu uma pastoral da lista ──
                if (text === '0') {
                    // Não participa de nenhuma → menu
                    const mainFlow = chatFlows['main_menu'];
                    userStates[phone] = { flowId: 'main_menu', idDizimista: state.idDizimista, nomeDizimista: state.nomeDizimista, apelidoDizimista: state.apelidoDizimista };
                    await msg.reply(
                        'Entendido! Quando precisar, fale com o coordenador para se vincular a uma pastoral.\n\n' +
                        (mainFlow ? mainFlow.message : '_Digite *menu* para ver as opções._')
                    );
                    return;
                }

                const idx = parseInt(text) - 1;
                const pastorais = state.pastoraisDisponiveis;
                if (isNaN(idx) || !pastorais || !pastorais[idx]) {
                    await msg.reply(`Opção inválida. Por favor, escolha um número entre *1* e *${pastorais ? pastorais.length : '?'}*, ou *0* para sair.`);
                    return;
                }

                const pastoralEscolhida = pastorais[idx];
                const idPastoral = pastoralEscolhida.ID_PASTORAL;
                const nomePastoral = pastoralEscolhida.NOME;
                const autocadastro = pastoralEscolhida.AUTOCADASTRO;
                const nomeServo = state.apelidoDizimista || state.nomeDizimista;

                let conn;
                try {
                    conn = await getOracleConnection();

                    if (autocadastro === 1) {
                        // --- AUTOCADASTRO: insere diretamente ---
                        // Verifica se já existe (segurança)
                        const jaExiste = await conn.execute(
                            `SELECT 1 FROM DIZIMISTA_PASTORAL WHERE ID_DIZIMISTA = :d AND ID_PASTORAL = :p`,
                            { d: state.idDizimista, p: idPastoral }
                        );
                        if (jaExiste.rows.length === 0) {
                            await conn.execute(
                                `INSERT INTO DIZIMISTA_PASTORAL (ID_DIZIMISTA, ID_PASTORAL, PAPEL) VALUES (:d, :p, 'M')`,
                                { d: state.idDizimista, p: idPastoral }
                            );
                        }
                        // Notifica coordenadores que o servo se cadastrou
                        const resCoord = await conn.execute(
                            `SELECT d.TELEFONE FROM DIZIMISTA_PASTORAL dp
                         JOIN DIZIMISTAS d ON dp.ID_DIZIMISTA = d.ID_DIZIMISTA
                         WHERE dp.ID_PASTORAL = :p AND dp.PAPEL = 'C'`,
                            { p: idPastoral }
                        );
                        for (const coord of resCoord.rows) {
                            if (coord.TELEFONE) {
                                await conn.execute(
                                    `INSERT INTO MENSAGENS (TELEFONE, TEXTO, STATUS) VALUES (:tel, :txt, 0)`,
                                    {
                                        tel: coord.TELEFONE,
                                        txt: `🟢 O servo *${nomeServo}* se cadastrou na pastoral *${nomePastoral}* pelo chatbot.`
                                    }
                                );
                            }
                        }
                        await msg.reply(
                            `✅ Você foi cadastrado(a) com sucesso na pastoral *${nomePastoral}*! 🙏\n\n` +
                            `O coordenador foi notificado.`
                        );
                        console.log(`[PASTORAL] ${nomeServo} cadastrado na pastoral "${nomePastoral}" (autocadastro).`);
                    } else {
                        // --- SEM AUTOCADASTRO: apenas envia solicitação ao coordenador ---
                        const resCoord = await conn.execute(
                            `SELECT d.TELEFONE FROM DIZIMISTA_PASTORAL dp
                         JOIN DIZIMISTAS d ON dp.ID_DIZIMISTA = d.ID_DIZIMISTA
                         WHERE dp.ID_PASTORAL = :p AND dp.PAPEL = 'C' AND d.STATUS = 1`,
                            { p: idPastoral }
                        );
                        for (const coord of resCoord.rows) {
                            if (coord.TELEFONE) {
                                await conn.execute(
                                    `INSERT INTO MENSAGENS (TELEFONE, TEXTO, STATUS) VALUES (:tel, :txt, 0)`,
                                    {
                                        tel: coord.TELEFONE,
                                        txt: `🟡 O servo *${nomeServo}* solicita inclusão na pastoral *${nomePastoral}* via chatbot. Por favor, verifique e aprove no sistema.`
                                    }
                                );
                            }
                        }
                        await msg.reply(
                            `💬 Sua solicitação de ingresso na pastoral *${nomePastoral}* foi enviada ao coordenador! 🙏\n\n` +
                            `Aguarde o contato do coordenador para confirmação da sua inclusão.`
                        );
                        console.log(`[PASTORAL] ${nomeServo} solicitou inclusão na pastoral "${nomePastoral}" (sujeito a aprovação).`);
                    }

                    // Volta ao menu principal
                    await new Promise(r => setTimeout(r, 1500));
                    const mainFlow = chatFlows['main_menu'];
                    userStates[phone] = { flowId: 'main_menu', idDizimista: state.idDizimista, nomeDizimista: state.nomeDizimista, apelidoDizimista: state.apelidoDizimista };
                    if (mainFlow) await msg.reply(mainFlow.message);

                } catch (err) {
                    console.error('[PASTORAL] Erro ao processar seleção de pastoral:', err);
                    await msg.reply('Ocorreu um erro ao processar sua solicitação. Tente novamente mais tarde.');
                } finally {
                    if (conn) await conn.close();
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
        } catch (handlerErr) {
            console.error(`[MSG-HANDLER] Erro não tratado para ${phone}:`, handlerErr);
        } finally {
            // Sempre libera o guard ao terminar o processamento
            processingPhones.delete(phone);
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
            const dbContacts = await getDizimistasCache();

            const chatData = chats.slice(0, 20).map(c => {
                const phoneOnly = c.id.user || '';
                const formatName = dbContacts[phoneOnly]
                    ? `[D] ${dbContacts[phoneOnly]}`
                    : (c.name || phoneOnly || 'Desconhecido');
                return {
                    id: c.id._serialized,
                    name: formatName,
                    unreadCount: c.unreadCount,
                    timestamp: c.timestamp
                };
            });
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

            let cached = messageCache[chatId] || [];
            if (cached.length === 0) {
                cached = [{
                    body: `[Aviso: O Histórico remoto do WhatsApp está indisponível devido a bugs atuais da plataforma Meta. Exibindo apenas mensagens desde que o servidor iniciou...]`,
                    fromMe: false,
                    timestamp: new Date().toLocaleTimeString()
                }];
            } else {
                cached = [{
                    body: `[Aviso: Devido a atualizações do WhatsApp, limitando o resgate de mensagens antigas, exibindo apenas as conversas capturadas recentemente na sessão atual do Servidor.]`,
                    fromMe: false,
                    timestamp: new Date().toLocaleTimeString()
                }, ...cached];
            }

            socket.emit('history', { chatId, messages: cached });
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

// Rotina de Disparo de Mensagens Agendadas
let messageIntervalFunc;
let isRoutineRunning = false; // Guard para evitar execuções simultâneas
const CHECK_INTERVAL_MINUTES = 10; // Configurável

function startMessageRoutine() {
    if (messageIntervalFunc) clearInterval(messageIntervalFunc);

    // Roda a cada X minutos (convertido para milissegundos)
    const intervalMs = CHECK_INTERVAL_MINUTES * 60 * 1000;

    // Roda a rotina pela primeira vez em 30 segundos após estar pronto
    setTimeout(execMessageRoutine, 30000);
    messageIntervalFunc = setInterval(execMessageRoutine, intervalMs);
}

async function execMessageRoutine() {
    // Dupla proteção: só roda se o WhatsApp estiver conectado E a rotina não estiver já em execução
    if (!isReady) {
        console.log('[ROUTINE] Skipped — WhatsApp não está pronto.');
        return;
    }
    if (isRoutineRunning) {
        console.log('[ROUTINE] Skipped — Rotina já em execução (evitando concorrência).');
        return;
    }

    isRoutineRunning = true;
    let conn;
    try {
        conn = await getOracleConnection();

        // Busca mensagens pendentes
        const result = await conn.execute(`
            SELECT ID_MENSAGENS, TELEFONE, TEXTO 
            FROM MENSAGENS 
            WHERE STATUS = 0
            ORDER BY ID_MENSAGENS ASC
        `);

        if (result.rows.length === 0) {
            console.log('[ROUTINE] Nenhuma mensagem pendente.');
            return;
        }

        console.log(`[ROUTINE] Encontradas ${result.rows.length} mensagens pendentes para envio.`);

        for (const row of result.rows) {
            // Verifica se o cliente ainda está ativo antes de cada envio
            if (!isReady) {
                console.log('[ROUTINE] WhatsApp desconectou durante a rotina. Abortando.');
                break;
            }

            try {
                let idMsg = row.ID_MENSAGENS;
                let phone = row.TELEFONE;
                let text = row.TEXTO;

                if (!phone || !text) {
                    await conn.execute(`UPDATE MENSAGENS SET STATUS = 2, RETORNO = 'Falha: Telefone ou Texto vazio' WHERE ID_MENSAGENS = :id`, { id: idMsg });
                    continue;
                }

                // Limpa e formata o telefone
                const cleanPhone = phone.replace(/\D/g, '');
                if (cleanPhone.length < 10) {
                    await conn.execute(`UPDATE MENSAGENS SET STATUS = 2, RETORNO = 'Falha: Número curto ou inválido' WHERE ID_MENSAGENS = :id`, { id: idMsg });
                    continue;
                }

                // Obtem o ID correto no WhatsApp (com timeout de proteção)
                let numberDetails = null;
                try {
                    numberDetails = await Promise.race([
                        client.getNumberId(cleanPhone),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('getNumberId timeout local')), 60000))
                    ]);
                } catch (timeoutErr) {
                    console.error(`[ROUTINE] Timeout em getNumberId para ID ${idMsg}:`, timeoutErr.message);
                    await conn.execute(`UPDATE MENSAGENS SET STATUS = 2, RETORNO = :ret WHERE ID_MENSAGENS = :id`, { ret: 'Falha: Timeout ao verificar número', id: idMsg });
                    continue;
                }

                if (numberDetails) {
                    const targetId = numberDetails._serialized;
                    await client.sendMessage(targetId, text);
                    console.log(`[ROUTINE] Mensagem ID ${idMsg} enviada com sucesso para ${phone}.`);

                    // Atualiza STATUS para 1
                    await conn.execute(`
                        UPDATE MENSAGENS 
                        SET STATUS = 1, RETORNO = 'Enviado com sucesso' 
                        WHERE ID_MENSAGENS = :id
                    `, { id: idMsg });
                } else {
                    console.log(`[ROUTINE] Número ${phone} não possui WhatsApp ativo.`);
                    await conn.execute(`UPDATE MENSAGENS SET STATUS = 2, RETORNO = 'Falha: Número não possui WhatsApp' WHERE ID_MENSAGENS = :id`, { id: idMsg });
                }
            } catch (sendErr) {
                console.error(`[ROUTINE] Erro ao enviar mensagem ID ${row.ID_MENSAGENS}:`, sendErr);
                let erroMsg = sendErr.message ? sendErr.message.substring(0, 950) : "Erro desconhecido";
                await conn.execute(`UPDATE MENSAGENS SET STATUS = 2, RETORNO = :ret WHERE ID_MENSAGENS = :id`, { ret: 'Exception: ' + erroMsg, id: row.ID_MENSAGENS });
            }

            // Pausa de 5 segundos entre cada disparo para evitar banimento do WhatsApp
            await new Promise(res => setTimeout(res, 5000));
        }
    } catch (err) {
        console.error('[ROUTINE] Erro na busca de mensagens:', err);
    } finally {
        if (conn) await conn.close();
        isRoutineRunning = false; // Sempre libera o guard ao terminar
    }
}

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
