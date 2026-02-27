//! Advanced arithmetic engine — deterministic, local, audited.
//! All sensitive numeric operations run here. Supports full arithmetic:
//! +, -, *, /, %, ^, sqrt, round, floor, ceil, abs, min, max, log, ln, exp, pow, etc.

use crate::audit::CalculationProof;
use evalexpr::{build_operator_tree, ContextWithMutableVariables, HashMapContext, EvalexprResult, Value};
use std::collections::BTreeMap;

/// Evaluate a single expression with optional variables.
/// Uses evalexpr built-in functions: min, max, floor, round, ceil,
/// math::sqrt, math::abs, math::ln, math::log, math::log2, math::log10,
/// math::exp, math::exp2, math::pow, and standard operators.
pub fn evaluate(expression: &str, variables: &BTreeMap<String, f64>) -> EvalexprResult<f64> {
    let mut context = HashMapContext::new();
    for (k, v) in variables {
        context
            .set_value(k.clone(), Value::Float(*v))
            .map_err(|e: evalexpr::EvalexprError| evalexpr::EvalexprError::CustomMessage(e.to_string()))?;
    }
    let node = build_operator_tree(expression)?;
    let result = node.eval_number_with_context(&context)?;
    Ok(result)
}

/// Evaluate multiple formulas with shared inputs. Returns values map and audit proof.
pub fn evaluate_spec(
    spec_id: &str,
    formulas: &BTreeMap<String, String>,
    inputs: &BTreeMap<String, f64>,
    outputs: &[String],
) -> Result<(BTreeMap<String, f64>, CalculationProof), String> {
    let mut values = BTreeMap::new();
    for (k, v) in inputs {
        values.insert(k.clone(), *v);
    }

    let mut context = HashMapContext::new();
    for (k, v) in inputs {
        context
            .set_value(k.clone(), Value::Float(*v))
            .map_err(|e: evalexpr::EvalexprError| e.to_string())?;
    }

    for out_name in outputs {
        let formula = formulas
            .get(out_name)
            .ok_or_else(|| format!("missing formula for output: {}", out_name))?;
        let node = build_operator_tree(formula).map_err(|e| e.to_string())?;
        let result = node.eval_number_with_context(&context).map_err(|e| e.to_string())?;
        values.insert(out_name.clone(), result);
        context
            .set_value(out_name.clone(), Value::Float(result))
            .map_err(|e: evalexpr::EvalexprError| e.to_string())?;
    }

    let outputs_only: BTreeMap<String, f64> = outputs
        .iter()
        .filter_map(|k| values.get(k).map(|v| (k.clone(), *v)))
        .collect();
    let inputs_json = serde_json::to_string(inputs).unwrap_or_default();
    let output_json = serde_json::to_string(&outputs_only).unwrap_or_default();
    let proof = CalculationProof::new(spec_id, "ARITHMETIC", &inputs_json, &output_json);

    Ok((outputs_only, proof))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn test_basic() {
        assert_eq!(evaluate("1 + 2", &BTreeMap::new()), Ok(3.0));
        assert_eq!(evaluate("10 * 2.5", &BTreeMap::new()), Ok(25.0));
    }

    #[test]
    fn test_with_vars() {
        let mut v = BTreeMap::new();
        v.insert("a".to_string(), 100.0);
        v.insert("b".to_string(), 25.0);
        assert_eq!(evaluate("a + b", &v), Ok(125.0));
        assert_eq!(evaluate("a * (1 + b/100)", &v), Ok(125.0));
    }

    #[test]
    fn test_advanced() {
        assert_eq!(evaluate("math::sqrt(144)", &BTreeMap::new()), Ok(12.0));
        assert_eq!(evaluate("round(99.7)", &BTreeMap::new()), Ok(100.0));
        assert_eq!(evaluate("floor(99.9)", &BTreeMap::new()), Ok(99.0));
        assert_eq!(evaluate("math::abs(-42)", &BTreeMap::new()), Ok(42.0));
        assert_eq!(evaluate("min(3, 7)", &BTreeMap::new()), Ok(3.0));
        assert_eq!(evaluate("2^10", &BTreeMap::new()), Ok(1024.0));
    }
}
