const fs = require('fs');

function fixFile(path) {
    if (!fs.existsSync(path)) return;
    let content = fs.readFileSync(path, 'utf8');
    
    // The duplicate looks like:
    // credit_vintage: 2024,
    // serial_number_start: 1,
    // serial_number_end: 10_000,
    // total_supply: 10_000,
    // credit_vintage: 2024,
    // serial_number_start: 1,
    // serial_number_end: 10_000,
    
    // We can replace two occurrences of this block with just one.
    const block = /credit_vintage:\s*2024,\s*serial_number_start:\s*1,\s*serial_number_end:\s*10_000,/g;
    
    // Wait, let's just do it manually with regex: remove one of the duplicates
    content = content.replace(/(credit_vintage:\s*2024,\s*serial_number_start:\s*1,\s*serial_number_end:\s*10_000,\s*)/g, (match, p1, offset, string) => {
        // If it's already there, just return nothing the second time?
        // Actually, just remove all of them, and then re-add them once after total_supply.
        return '';
    });
    
    // Now re-add them after total_supply
    content = content.replace(/(total_supply:\s*[^,]+,?)/g, '$1\n            credit_vintage: 2024,\n            serial_number_start: 1,\n            serial_number_end: 10_000,');
    
    fs.writeFileSync(path, content);
}

fixFile('contracts/credit-retirement/src/lib.rs');
fixFile('contracts/tests/src/lib.rs');
fixFile('contracts/dex-router/src/lib.rs');
fixFile('contracts/coupon-engine/src/lib.rs');

