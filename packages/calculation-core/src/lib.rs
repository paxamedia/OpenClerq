//! OpenClerq Calculation Core — Deterministic arithmetic engine.
//! All sensitive numeric operations run locally. AI never computes; this engine does.

pub mod arithmetic;
pub mod audit;

pub use arithmetic::{evaluate, evaluate_spec};
pub use audit::CalculationProof;
