const oracledb = require('oracledb');
const path = require('path');

const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: path.join(__dirname, '..', 'DriveOracle'),
    walletPassword: "Alinne05@ora"
};

async function checkTypes() {
    process.env.TNS_ADMIN = oracleConfig.walletLocation;
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    
    let conn;
    try {
        conn = await oracledb.getConnection(oracleConfig);
        const res = await conn.execute(`
            SELECT COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS WHERE TABLE_NAME = 'MISSAS' AND OWNER = 'DIZIMO'
        `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        if (conn) await conn.close();
    }
}

checkTypes();
