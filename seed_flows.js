const oracledb = require('oracledb');
const path = require('path');

const oracleConfig = {
    user: "DIZIMO",
    password: "Alinne05@ora",
    connectString: "imaculado_high",
    walletLocation: path.join(__dirname, 'DriveOracle'),
    walletPassword: "Alinne05@ora"
};

async function seed() {
    let conn;
    try {
        process.env.TNS_ADMIN = oracleConfig.walletLocation;
        conn = await oracledb.getConnection({
            user: oracleConfig.user,
            password: oracleConfig.password,
            connectString: oracleConfig.connectString,
            configDir: oracleConfig.walletLocation
        });

        const mainMenu = {
            id: 'main_menu',
            triggers: 'menu, ajuda, oi',
            message: "*Menu da Paróquia* 🙏\n\nEscolha uma opção:\n1️⃣ *Servir*: Candidatar-se para trabalhar em uma missa.\n2️⃣ *Missas*: Ver horários das missas do mês.\n\n_Digite o número da opção desejada._",
            options: JSON.stringify({
                "1": { "type": "function", "value": "fluxoServir" },
                "2": { "type": "function", "value": "listarMissas" }
            })
        };

        const mergeSql = `
            MERGE INTO flows f
            USING (SELECT :id as id FROM dual) src
            ON (f.id = src.id)
            WHEN MATCHED THEN
                UPDATE SET triggers = :triggers, message = :message, options = :options
            WHEN NOT MATCHED THEN
                INSERT (id, triggers, message, options) VALUES (:id, :triggers, :message, :options)
        `;

        await conn.execute(mergeSql, mainMenu);
        await conn.commit();
        console.log('Main Menu flow seeded successfully into Oracle FLOWS table.');

    } catch (err) {
        console.error('Error seeding flows:', err);
    } finally {
        if (conn) await conn.close();
    }
}

seed();
