//! Audit proof generation for calculations

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalculationProof {
    pub calculation_id: String,
    pub timestamp: DateTime<Utc>,
    pub scope: String,
    pub operation: String,
    pub inputs_hash: String,
    pub output_hash: String,
    pub proof_hash: String,
    pub engine_version: String,
    pub is_audit_ready: bool,
}

impl CalculationProof {
    pub fn new(scope: &str, operation: &str, inputs_json: &str, output_json: &str) -> Self {
        let timestamp = Utc::now();
        let hash = Sha256::digest(format!("{}{}", timestamp.timestamp(), inputs_json).as_bytes());
        let calculation_id = format!(
            "calc_{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]
        );
        let engine_version = env!("CARGO_PKG_VERSION").to_string();

        let inputs_hash = format!("{:x}", Sha256::digest(inputs_json.as_bytes()));
        let output_hash = format!("{:x}", Sha256::digest(output_json.as_bytes()));

        let to_sign = format!(
            "{}|{}|{}|{}|{}|{}",
            calculation_id,
            timestamp.to_rfc3339(),
            scope,
            operation,
            inputs_hash,
            output_hash
        );
        let proof_hash = format!("{:x}", Sha256::digest(to_sign.as_bytes()));

        Self {
            calculation_id,
            timestamp,
            scope: scope.to_string(),
            operation: operation.to_string(),
            inputs_hash,
            output_hash,
            proof_hash,
            engine_version,
            is_audit_ready: true,
        }
    }
}
