const oracledb = require('oracledb');
const path = require('path');

const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: "c:\\Users\\admin\\OneDrive\\Documentos\\ProjetosIA\\ChatBot\\DriveOracle",
    walletPassword: "Alinne05@ora"
};

async function checkLigiaStatus() {
    process.env.TNS_ADMIN = oracleConfig.walletLocation;
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    
    let conn;
    try {
        conn = await oracledb.getConnection(oracleConfig);
        const res = await conn.execute(`
            SELECT ID_DIZIMISTA, NOME, APELIDO, STATUS FROM DIZIMISTAS 
            WHERE NOME LIKE '%Ligia%'
        `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        if (conn) await conn.close();
    }
}

checkLigiaStatus();
