const oracledb = require('oracledb');
const path = require('path');
const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: path.join(__dirname, '..', 'DriveOracle'),
    walletPassword: "Alinne05@ora"
};

async function test() {
    process.env.TNS_ADMIN = oracleConfig.walletLocation;
    let conn;
    try {
        conn = await oracledb.getConnection(oracleConfig);
        console.time('query');
        const res = await conn.execute(`SELECT ID_DIZIMISTA, NOME, TELEFONE FROM DIZIMISTAS WHERE REGEXP_REPLACE(CPF,'[^0-9]','') = :cpf AND STATUS = 1`, { cpf: '06828040104' });
        console.timeEnd('query');
        console.log(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        if (conn) await conn.close();
    }
}
test();
