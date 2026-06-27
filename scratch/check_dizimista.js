const oracledb = require('oracledb');
const path = require('path');

const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: path.join(__dirname, '..', 'DriveOracle'),
    walletPassword: "Alinne05@ora"
};

async function checkAudit() {
    process.env.TNS_ADMIN = oracleConfig.walletLocation;
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    oracledb.fetchAsString = [oracledb.CLOB];
    
    let conn;
    try {
        conn = await oracledb.getConnection(oracleConfig);
        
        console.log("=== Checking Audit for ID_REGISTRO = 263 (Andrea) ===");
        let res = await conn.execute(`
            SELECT ID_AUDITORIA, TABELA, ID_REGISTRO, OPERACAO, USUARIO, DATA_HORA, DADOS_ANTERIORES, DADOS_NOVOS
            FROM AUDITORIA 
            WHERE TABELA = 'DIZIMISTAS' AND ID_REGISTRO = 263
            ORDER BY DATA_HORA DESC
        `);
        for (const row of res.rows) {
            console.log(`ID: ${row.ID_AUDITORIA}, OP: ${row.OPERACAO}, USER: ${row.USUARIO}, DATE: ${row.DATA_HORA}`);
            console.log(`  PREV: ${row.DADOS_ANTERIORES}`);
            console.log(`  NEW: ${row.DADOS_NOVOS}`);
        }

        console.log("=== Checking Audit for ID '3745312157941' ===");
        res = await conn.execute(`
            SELECT ID_AUDITORIA, TABELA, ID_REGISTRO, OPERACAO, USUARIO, DATA_HORA, DADOS_ANTERIORES, DADOS_NOVOS
            FROM AUDITORIA 
            WHERE DADOS_ANTERIORES LIKE '%3745312157941%' OR DADOS_NOVOS LIKE '%3745312157941%'
            ORDER BY DATA_HORA DESC
        `);
        for (const row of res.rows) {
            console.log(`ID: ${row.ID_AUDITORIA}, TABELA: ${row.TABELA}, REGISTRO: ${row.ID_REGISTRO}, OP: ${row.OPERACAO}, USER: ${row.USUARIO}, DATE: ${row.DATA_HORA}`);
            console.log(`  PREV: ${row.DADOS_ANTERIORES}`);
            console.log(`  NEW: ${row.DADOS_NOVOS}`);
        }

    } catch (err) {
        console.error(err);
    } finally {
        if (conn) await conn.close();
    }
}

checkAudit();
