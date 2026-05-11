//! sp1-prover/program/src/main.rs
//!
//! Lightweight SP1 zkVM program to prove an Ethereum wallet balance
//! was below a given threshold at a specific block.

#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_primitives::{keccak256, Address, U256};
use serde::{Deserialize, Serialize};

/// Public inputs (will be verified on Solana)
#[derive(Serialize, Deserialize)]
pub struct BalanceProofPublicInputs {
    pub block_number: u64,
    pub state_root: [u8; 32],
    pub wallet_address: [u8; 20],
    pub threshold_wei: [u8; 32],
    pub rule_id: [u8; 32],
}

/// Private witness data
#[derive(Serialize, Deserialize)]
pub struct BalanceProofWitness {
    pub block_header_rlp: Vec<u8>,
    pub account_proof: Vec<Vec<u8>>,
    pub account_rlp: Vec<u8>,
}

pub fn main() {
    let public: BalanceProofPublicInputs = sp1_zkvm::io::read();
    let witness: BalanceProofWitness = sp1_zkvm::io::read();

    // 1. Extract and verify state root from block header
    let state_root = extract_state_root(&witness.block_header_rlp);
    assert_eq!(state_root, public.state_root, "State root mismatch");

    // 2. Verify Merkle-Patricia proof
    let address = Address::from(public.wallet_address);
    let account_key = keccak256(address.as_slice());
    verify_merkle_proof(
        &public.state_root,
        &account_key.0,
        &witness.account_proof,
        &witness.account_rlp,
    );

    // 3. Decode balance and check condition
    let balance = decode_account_balance(&witness.account_rlp);
    let threshold = U256::from_be_bytes(public.threshold_wei);

    assert!(balance < threshold, "Balance is not below threshold");

    // Commit public inputs for on-chain verification
    sp1_zkvm::io::commit(&public);
}

// ================================================================
// Helper Functions (Optimized for lower memory usage)
// ================================================================

fn extract_state_root(header_rlp: &[u8]) -> [u8; 32] {
    let items = rlp_decode_list(header_rlp);
    assert!(items.len() > 3, "Invalid block header RLP");
    let mut root = [0u8; 32];
    root.copy_from_slice(&items[3]);
    root
}

fn decode_account_balance(account_rlp: &[u8]) -> U256 {
    let items = rlp_decode_list(account_rlp);
    assert!(items.len() >= 2, "Invalid account RLP");
    U256::from_be_slice(&items[1])
}

/// Simple Merkle-Patricia Trie proof verifier
fn verify_merkle_proof(root: &[u8; 32], key: &[u8; 32], proof: &[Vec<u8>], expected_value: &[u8]) {
    let mut current_hash = *root;
    let key_nibbles = to_nibbles(key);
    let mut nibble_idx = 0usize;

    for node_rlp in proof {
        let node_hash: [u8; 32] = keccak256(node_rlp).into();
        assert_eq!(node_hash, current_hash, "Proof node hash mismatch");

        let node = rlp_decode_list(node_rlp);

        match node.len() {
            17 => {
                // Branch node
                let nibble = key_nibbles[nibble_idx] as usize;
                nibble_idx += 1;
                current_hash.copy_from_slice(&node[nibble]);
            }
            2 => {
                // Leaf or Extension node
                let path = decode_compact_path(&node[0]);
                nibble_idx += path.len();

                if nibble_idx >= key_nibbles.len() {
                    // Leaf node
                    assert_eq!(node[1], expected_value, "Leaf value mismatch");
                    return;
                } else {
                    // Extension node
                    current_hash.copy_from_slice(&node[1]);
                }
            }
            _ => panic!("Invalid trie node length"),
        }
    }
    panic!("Proof verification failed");
}

// ================================================================
// RLP Helpers (Minimal allocation)
// ================================================================

fn to_nibbles(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().flat_map(|b| [b >> 4, b & 0x0F]).collect()
}

fn decode_compact_path(encoded: &[u8]) -> Vec<u8> {
    if encoded.is_empty() {
        return vec![];
    }
    let flag = encoded[0] >> 4;
    let skip = if flag % 2 == 0 { 2 } else { 1 };
    to_nibbles(&encoded[skip / 2..])
}

fn rlp_decode_list(data: &[u8]) -> Vec<Vec<u8>> {
    let mut items = Vec::new();
    let (_, payload) = rlp_strip_list_prefix(data);
    let mut i = 0;
    while i < payload.len() {
        let (item, len) = rlp_decode_item(&payload[i..]);
        items.push(item);
        i += len;
    }
    items
}

fn rlp_strip_list_prefix(data: &[u8]) -> (usize, &[u8]) {
    let first = data[0] as usize;
    if first <= 0xf7 {
        (1, &data[1..1 + (first - 0xc0)])
    } else {
        let len_bytes = first - 0xf7;
        let mut len = 0usize;
        for &b in &data[1..1 + len_bytes] {
            len = (len << 8) | b as usize;
        }
        (1 + len_bytes, &data[1 + len_bytes..1 + len_bytes + len])
    }
}

fn rlp_decode_item(data: &[u8]) -> (Vec<u8>, usize) {
    let first = data[0] as usize;
    if first < 0x80 {
        (vec![data[0]], 1)
    } else if first <= 0xb7 {
        let len = first - 0x80;
        (data[1..1 + len].to_vec(), 1 + len)
    } else if first <= 0xbf {
        let len_bytes = first - 0xb7;
        let mut len = 0usize;
        for &b in &data[1..1 + len_bytes] {
            len = (len << 8) | b as usize;
        }
        (
            data[1 + len_bytes..1 + len_bytes + len].to_vec(),
            1 + len_bytes + len,
        )
    } else {
        let (prefix_len, payload) = rlp_strip_list_prefix(data);
        let total = prefix_len + payload.len();
        (data[..total].to_vec(), total)
    }
}
