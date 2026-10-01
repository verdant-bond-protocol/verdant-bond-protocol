const fs = require('fs');

let content = fs.readFileSync('contracts/bond-issuer/src/lib.rs', 'utf8');

const replacement = `        let mut config2 = config.clone();
        config2.serial_number_start = 10001;
        config2.serial_number_end = 20000;
        client.issue_bond(&admin, &config2, &1);`;

content = content.replace('client.issue_bond(&admin, &config, &1);', replacement);

fs.writeFileSync('contracts/bond-issuer/src/lib.rs', content);
