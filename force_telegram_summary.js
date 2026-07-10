const oracledb = require('oracledb');
const path = require('path');
const https = require('https');
const fs = require('fs');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
process.env.TNS_ADMIN = path.join(__dirname, 'DriveOracle');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

function sendTelegramAlertDirect(token, chatId, text) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' });
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve();
                else reject(new Error(`Erro API: ${res.statusCode} - ${data}`));
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function forceSummary() {
    let conn;
    try {
        conn = await oracledb.getConnection({
            user: 'DIZIMO',
            password: 'Alinne05@ora',
            connectString: 'imaculado_high',
            walletLocation: path.join(__dirname, 'DriveOracle'),
            walletPassword: 'Alinne05@ora',
            configDir: path.join(__dirname, 'DriveOracle')
        });

        const result = await conn.execute(`
            SELECT STATUS, COUNT(*) AS QTD
            FROM MENSAGENS
            WHERE DATAHORA >= TRUNC(SYSDATE - 1)
              AND DATAHORA < TRUNC(SYSDATE)
            GROUP BY STATUS
        `);

        let successCount = 0;
        let errorCount = 0;
        let pendingCount = 0;

        for (const row of result.rows) {
            if (row.STATUS === 1) successCount = row.QTD;
            else if (row.STATUS === 2) errorCount = row.QTD;
            else if (row.STATUS === 0) pendingCount = row.QTD;
        }

        const messageText = 
            `📊 *Resumo de Disparos - Ontem (TESTE FORÇADO)*\n\n` +
            `✅ *Enviadas com sucesso:* ${successCount}\n` +
            `❌ *Erros no envio:* ${errorCount}\n` +
            `⏳ *Pendentes:* ${pendingCount}`;
            
        console.log(`Enviando resumo diário via Telegram...`);
        await sendTelegramAlertDirect(config.telegramToken, config.telegramChatId, messageText);
        console.log('Mensagem enviada com sucesso para o Telegram!');
    } catch (err) {
        console.error('Erro:', err);
    } finally {
        if (conn) await conn.close();
    }
}

forceSummary();
