import os, re

for root, dirs, files in os.walk('contracts/'):
    for file in files:
        if file.endswith('.rs'):
            path = os.path.join(root, file)
            if 'types.rs' in path:
                continue
            with open(path, 'r') as f:
                content = f.read()
            if 'total_supply:' in content and 'BondConfig' in content:
                # Add credit_vintage, serial_number_start, serial_number_end
                new_content = re.sub(
                    r'(total_supply:\s*[^,]+,?)',
                    r'\1\n            credit_vintage: 2024,\n            serial_number_start: 1,\n            serial_number_end: 10_000,',
                    content
                )
                if new_content != content:
                    with open(path, 'w') as f:
                        f.write(new_content)
                    print(f"Patched {path}")
