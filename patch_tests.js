const fs = require('fs');
let content = fs.readFileSync('contracts/bond-issuer/src/lib.rs', 'utf8');

// Replace svec! with vec! in test_issue_bond_overlap_detection
content = content.replace(/svec!/g, 'vec!');

// Replace make_project_id with create_project_id
content = content.replace(/make_project_id/g, 'create_project_id');

fs.writeFileSync('contracts/bond-issuer/src/lib.rs', content);
