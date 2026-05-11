#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_primitives::U256;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct PublicInputs {
    pub threshold_wei: [u8; 32],
}

pub fn main() {
    let public: PublicInputs = sp1_zkvm::io::read();

    // Dummy check - just to make it compile and run
    let threshold = U256::from_be_bytes(public.threshold_wei);
    assert!(threshold > U256::ZERO, "Threshold must be > 0");

    sp1_zkvm::io::commit(&public);
}
