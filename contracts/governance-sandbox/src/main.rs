use nbbs_governance_sandbox::{simulate, Plan};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err(
            "Usage: nbbs-governance-sandbox SNAPSHOT.json PLAN.json (report on stdout)".into(),
        );
    }
    let snapshot = std::fs::read(&args[1])?;
    let plan: Plan = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let report = simulate(&snapshot, &plan)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
