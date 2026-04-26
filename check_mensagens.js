const oracledb = require('oracledb');
const path = require('path');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
process.env.TNS_ADMIN = path.join(__dirname, 'DriveOracle');

async function check() {
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

        // 1. Colunas da tabela MENSAGENS
        const cols = await conn.execute(
            `SELECT COLUMN_NAME, DATA_TYPE FROM USER_TAB_COLUMNS WHERE TABLE_NAME='MENSAGENS' ORDER BY COLUMN_ID`
        );
        console.log('\n=== COLUNAS DA TABELA MENSAGENS ===');
        cols.rows.forEach(r => console.log(` - ${r.COLUMN_NAME} (${r.DATA_TYPE})`));

        // 2. Registros com STATUS = 0
        const pend = await conn.execute(`SELECT * FROM MENSAGENS WHERE STATUS = 0`);
        console.log(`\n=== REGISTROS PENDENTES (STATUS=0): ${pend.rows.length} ===`);
        pend.rows.forEach(r => console.log(JSON.stringify(r)));

        // 3. Todos os registros (ultimos 10)
        const all = await conn.execute(`SELECT * FROM MENSAGENS ORDER BY ID_MENSAGENS DESC FETCH FIRST 10 ROWS ONLY`);
        console.log(`\n=== ULTIMOS 10 REGISTROS ===`);
        all.rows.forEach(r => console.log(JSON.stringify(r)));

    } catch (err) {
        console.error('ERRO:', err.message);
    } finally {
        if (conn) await conn.close();
    }
}

check();
