const oracledb = require('oracledb');
const path = require('path');

const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: __dirname + "\\DriveOracle",
    walletPassword: "Alinne05@ora"
};

async function checkSchema() {
    process.env.TNS_ADMIN = oracleConfig.walletLocation;
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    
    let conn;
    try {
        conn = await oracledb.getConnection({
            user: oracleConfig.user,
            password: oracleConfig.password,
            connectString: oracleConfig.connectString,
            walletLocation: oracleConfig.walletLocation,
            walletPassword: oracleConfig.walletPassword,
            configDir: oracleConfig.walletLocation
        });

        const res = await conn.execute(`
            SELECT DISTINCT PAPEL FROM DIZIMISTA_PASTORAL
        `);
        console.log(JSON.stringify(res.rows, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        if (conn) await conn.close();
    }
}

checkSchema();
