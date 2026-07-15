const oracledb = require('oracledb');
const path = require('path');

const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: path.join('c:\\Users\\admin\\DriveVirtual\\ProjetosIA\\ChatBot', 'DriveOracle'),
    walletPassword: "Alinne05@ora"
};

process.env.TNS_ADMIN = oracleConfig.walletLocation;

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

async function run() {
    let conn;
    try {
        await oracledb.createPool({
            ...oracleConfig,
            configDir: oracleConfig.walletLocation,
            poolMin: 1,
            poolMax: 2,
        });
        conn = await oracledb.getConnection();
        const result = await conn.execute(`
            SELECT ID_MENSAGENS, TELEFONE, STATUS, RETORNO
            FROM MENSAGENS 
            WHERE ID_MENSAGENS > 2042 AND STATUS = 2
            ORDER BY ID_MENSAGENS ASC
        `);
        console.log(JSON.stringify(result.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        if (conn) {
            await conn.close();
        }
        await oracledb.getPool().close(0);
    }
}
run();
