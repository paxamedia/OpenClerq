//! Clerq calculation CLI — JSON in (stdin), JSON out (stdout).
//! Advanced arithmetic: expressions, formulas, variables. All operations logged locally.

use clerq_calculation_core::{evaluate, evaluate_spec, CalculationProof};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

#[derive(Debug, Serialize)]
struct EvalResponse {
    values: BTreeMap<String, f64>,
    proof: CalculationProof,
}

#[derive(Debug, Deserialize)]
struct EvalInput {
    #[serde(rename = "operation")]
    op: String,
    #[serde(default)]
    expression: Option<String>,
    #[serde(default)]
    inputs: Option<BTreeMap<String, f64>>,
    #[serde(default)]
    spec: Option<Spec>,
}

#[derive(Debug, Deserialize)]
struct Spec {
    id: Option<String>,
    #[serde(default)]
    formulas: BTreeMap<String, String>,
    #[serde(default)]
    output_names: Vec<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    let line = line.trim();
    if line.is_empty() {
        eprintln!("Usage: echo '{{\"operation\":\"eval\",\"expression\":\"a + b\",\"inputs\":{{\"a\":10,\"b\":5}}}}' | clerq-calc");
        eprintln!("       echo '{{\"operation\":\"eval\",\"spec\":{{\"formulas\":{{\"r\":\"a*b\"}},\"output_names\":[\"r\"]}},\"inputs\":{{\"a\":10,\"b\":5}}}}' | clerq-calc");
        std::process::exit(1);
    }

    let input: EvalInput = serde_json::from_str(line)?;

    let output = match input.op.as_str() {
        "eval" => {
            let inputs = input.inputs.unwrap_or_default();
            let spec_id = input
                .spec
                .as_ref()
                .and_then(|s| s.id.clone())
                .unwrap_or_else(|| "eval".to_string());

            if let Some(expr) = input.expression {
                let result = evaluate(&expr, &inputs).map_err(|e| e.to_string())?;
                let mut values = BTreeMap::new();
                values.insert("result".to_string(), result);
                let inputs_json = serde_json::to_string(&inputs).unwrap_or_default();
                let output_json = serde_json::to_string(&values).unwrap_or_default();
                let proof = CalculationProof::new(&spec_id, "ARITHMETIC", &inputs_json, &output_json);
                serde_json::to_value(EvalResponse { values, proof })?
            } else if let Some(spec) = input.spec {
                let outputs = if spec.output_names.is_empty() {
                    spec.formulas.keys().cloned().collect()
                } else {
                    spec.output_names
                };
                let (values, proof) =
                    evaluate_spec(&spec_id, &spec.formulas, &inputs, &outputs)?;
                serde_json::to_value(EvalResponse { values, proof })?
            } else {
                return Err("eval requires 'expression' or 'spec'".into());
            }
        }
        _ => return Err(format!("unknown operation: {}", input.op).into()),
    };

    io::stdout().write_all(output.to_string().as_bytes())?;
    writeln!(io::stdout())?;
    Ok(())
}
