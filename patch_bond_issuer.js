const fs = require('fs');

let content = fs.readFileSync('contracts/bond-issuer/src/lib.rs', 'utf8');

// Add BytesN to import
content = content.replace('soroban_sdk::{contract,', 'soroban_sdk::{BytesN, contract,');

// Add SerialRange
content = content.replace(
    'pub enum DataKey {',
    `pub enum DataKey {
    CommittedRanges(BytesN<32>, u64),`
);

content = content.replace(
    '#[derive(Clone, Debug)]\n#[contracttype]\npub struct BondState {',
    `#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct SerialRange {
    pub start: i128,
    pub end: i128,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct BondState {`
);


// Add overlap check in issue_bond
const overlapCheck = `        let range_key = DataKey::CommittedRanges(config.project_id.clone(), config.credit_vintage);
        let mut ranges: Vec<SerialRange> = env.storage().persistent().get(&range_key).unwrap_or(vec![&env]);
        
        let new_start = config.serial_number_start;
        let new_end = config.serial_number_end;
        
        if new_start > new_end {
            return Err(BondError::InvalidSupply);
        }
        
        for i in 0..ranges.len() {
            let r = ranges.get(i).unwrap();
            let max_start = if new_start > r.start { new_start } else { r.start };
            let min_end = if new_end < r.end { new_end } else { r.end };
            if max_start <= min_end {
                return Err(BondError::InvalidSupply);
            }
        }
        
        ranges.push_back(SerialRange { start: new_start, end: new_end });
        env.storage().persistent().set(&range_key, &ranges);

        let bond_id = count + 1;`;

content = content.replace('let bond_id = count + 1;', overlapCheck);

fs.writeFileSync('contracts/bond-issuer/src/lib.rs', content);
