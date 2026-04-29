const oracledb = require('oracledb');
const path = require('path');

const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: path.join(__dirname, '..', 'DriveOracle'),
    walletPassword: "Alinne05@ora"
};

async function checkPerfis() {
    process.env.TNS_ADMIN = oracleConfig.walletLocation;
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    
    let conn;
    try {
        conn = await oracledb.getConnection(oracleConfig);
        const res = await conn.execute(`
            SELECT COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE TABLE_NAME = 'PERFIS' AND OWNER = 'DIZIMO'
        `);
        console.log("PERFIS columns:");
        console.log(JSON.stringify(res.rows, null, 2));

        const res2 = await conn.execute(`
            SELECT table_name FROM user_tables WHERE table_name LIKE '%PERMIS%'
        `);
        console.log("Permission tables:");
        console.log(JSON.stringify(res2.rows, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        if (conn) await conn.close();
    }
}

checkPerfis();
