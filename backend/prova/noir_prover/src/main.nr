// noir-prover/circuit/src/main.nr
//
// Proves that an Ethereum wallet balance was below a threshold
// at a specific block, using a Merkle-Patricia trie proof.
//
// Public inputs (visible on-chain after verification):
//   block_number    - Ethereum block number
//   state_root      - Block state root (32 bytes)
//   wallet_address  - ETH address being monitored (20 bytes)
//   threshold_wei   - Balance threshold in wei (32 bytes, big-endian)
//   rule_id         - Prova rule ID (32 bytes)
//
// Private witnesses (never revealed):
//   account_rlp         - RLP-encoded account state [nonce, balance, storage_root, code_hash]
//   account_proof_nodes - Merkle-Patricia proof nodes (up to 10 nodes, each 532 bytes max)
//   account_proof_lens  - Actual byte length of each proof node
//   num_proof_nodes     - Number of valid proof nodes
//   header_rlp          - RLP-encoded block header (up to 700 bytes)
//   header_rlp_len      - Actual byte length of header
use dep::keccak256::keccak256;

//  Constants 

// Max proof depth for Ethereum MPT (in practice 6-9 nodes)
global MAX_PROOF_NODES: u32 = 10;
// Max RLP bytes per proof node
global MAX_NODE_LEN: u32 = 532;
// Max block header RLP size
global MAX_HEADER_LEN: u32 = 700;
// Max account RLP size (nonce + balance + storage_root + code_hash)
global MAX_ACCOUNT_LEN: u32 = 110;

//  Keccak256 

// Noir has a built-in keccak256  takes fixed array, returns [u8; 32]
fn keccak256_fixed<let N: u32>(input: [u8; N], input_len: u32) -> [u8; 32] {
   keccak256(input, input_len)
}

//  RLP decoding helpers 

// Decode a single RLP item starting at offset, return (value_offset, value_len, next_offset)
fn rlp_decode_item(data: [u8; MAX_NODE_LEN], offset: u32) -> (u32, u32, u32) {
    let first = data[offset] as u32;

    if first < 0x80 {
        // Single byte
        (offset, 1, offset + 1)
    } else if first <= 0xb7 {
        // Short string
        let len = first - 0x80;
        (offset + 1, len, offset + 1 + len)
    } else if first <= 0xbf {
        // Long string
        let len_bytes = first - 0xb7;
        let mut len: u32 = 0;
        for i in 0..4 {
            if (i as u32) < len_bytes {
                len = (len << 8) | (data[offset + 1 + i as u32] as u32);
            }
        }
        (offset + 1 + len_bytes, len, offset + 1 + len_bytes + len)
    } else if first <= 0xf7 {
        // Short list  return raw including prefix
        let len = first - 0xc0;
        (offset, 1 + len, offset + 1 + len)
    } else {
        // Long list
        let len_bytes = first - 0xf7;
        let mut len: u32 = 0;
        for i in 0..4 {
            if (i as u32) < len_bytes {
                len = (len << 8) | (data[offset + 1 + i as u32] as u32);
            }
        }
        (offset, 1 + len_bytes + len, offset + 1 + len_bytes + len)
    }
}

// Strip list prefix  return (payload_start, payload_len)
fn rlp_strip_list_prefix(data: [u8; MAX_NODE_LEN], offset: u32) -> (u32, u32) {
    let first = data[offset] as u32;
    if first <= 0xf7 {
        (offset + 1, first - 0xc0)
    } else {
        let len_bytes = first - 0xf7;
        let mut len: u32 = 0;
        for i in 0..4 {
            if (i as u32) < len_bytes {
                len = (len << 8) | (data[offset + 1 + i as u32] as u32);
            }
        }
        (offset + 1 + len_bytes, len)
    }
}

// Count items in an RLP list
fn rlp_count_items(data: [u8; MAX_NODE_LEN], payload_start: u32, payload_len: u32) -> u32 {
    let mut count: u32 = 0;
    let mut i = payload_start;
    for _ in 0..20 {
        if i < payload_start + payload_len {
            let (_, _, next) = rlp_decode_item(data, i);
            count += 1;
            i = next;
        }
    }
    count
}

//  Account RLP decoding 

// Account state: [nonce, balance, storage_root, code_hash]
// Extract balance (index 1) as 32-byte big-endian
fn decode_balance_from_account_rlp(account_rlp: [u8; MAX_ACCOUNT_LEN]) -> [u8; 32] {
    // Skip list prefix
    let first = account_rlp[0] as u32;
    let payload_start: u32 = if first <= 0xf7 {
        1
    } else {
        1 + (first - 0xf7)
    };

    // Skip item 0 (nonce)
    let nonce_first = account_rlp[payload_start] as u32;
    let after_nonce: u32 = if nonce_first < 0x80 {
        payload_start + 1
    } else {
        let nonce_len = nonce_first - 0x80;
        payload_start + 1 + nonce_len
    };

    // Read item 1 (balance)
    let bal_first = account_rlp[after_nonce] as u32;
    let (bal_offset, bal_len): (u32, u32) = if bal_first < 0x80 {
        // Single byte value
        (after_nonce, 1)
    } else {
        let len = bal_first - 0x80;
        (after_nonce + 1, len)
    };

    // Pack into 32-byte big-endian (right-aligned)
    let mut result = [0 as u8; 32];
    let pad = 32 - bal_len;
    for i in 0..32 {
        if (i as u32) >= pad {
            let src_idx = bal_offset + (i as u32) - pad;
            if bal_first < 0x80 {
                // Single byte: the byte itself is at bal_offset
                result[i] = account_rlp[after_nonce];
            } else {
                result[i] = account_rlp[src_idx];
            }
        }
    }
    result
}

//  U256 comparison 

// Compare two 32-byte big-endian numbers: a < b
fn u256_lt(a: [u8; 32], b: [u8; 32]) -> bool {
    let mut result = false;
    let mut decided = false;
    for i in 0..32 {
        if !decided {
            if a[i] < b[i] {
                result = true;
                decided = true;
            } else if a[i] > b[i] {
                result = false;
                decided = true;
            }
        }
    }
    result
}

//  Nibble helpers 

fn byte_to_nibbles(b: u8) -> (u8, u8) {
    (b >> 4, b & 0x0f)
}

//  Block header state root extraction 

// Block header RLP list: [parentHash, uncleHash, coinbase, stateRoot, ...]
// stateRoot is item index 3
fn extract_state_root(header_rlp: [u8; MAX_HEADER_LEN], header_len: u32) -> [u8; 32] {
    // Strip outer list prefix
    let first = header_rlp[0] as u32;
    let payload_start: u32 = if first <= 0xf7 {
        1
    } else {
        let lb = first - 0xf7;
        1 + lb
    };

    // Walk items 0, 1, 2 to get to item 3 (stateRoot)
    let mut offset = payload_start;
    for _skip in 0..3 {
        let b = header_rlp[offset] as u32;
        if b < 0x80 {
            offset += 1;
        } else if b <= 0xb7 {
            offset += 1 + (b - 0x80);
        } else if b <= 0xbf {
            let lb = b - 0xb7;
            let mut l: u32 = 0;
            for k in 0..4 {
                if (k as u32) < lb {
                    l = (l << 8) | (header_rlp[offset + 1 + k as u32] as u32);
                }
            }
            offset += 1 + lb + l;
        } else if b <= 0xf7 {
            offset += 1 + (b - 0xc0);
        } else {
            let lb = b - 0xf7;
            let mut l: u32 = 0;
            for k in 0..4 {
                if (k as u32) < lb {
                    l = (l << 8) | (header_rlp[offset + 1 + k as u32] as u32);
                }
            }
            offset += 1 + lb + l;
        }
    }

    // Item 3 is stateRoot should be 0xa0 prefix (32-byte string)
    // Skip the 0xa0 prefix byte
    offset += 1;
    let mut root = [0 as u8; 32];
    for i in 0..32 {
        root[i] = header_rlp[offset + i as u32];
    }
    root
}

//  Merkle-Patricia trie verification 

// Verify account exists in the MPT at keccak256(wallet_address)
// proof_nodes: up to MAX_PROOF_NODES nodes, each padded to MAX_NODE_LEN
// proof_lens:  actual byte length of each node
// num_nodes:   how many nodes are valid
fn verify_mpt_proof(
    state_root: [u8; 32],
    account_key: [u8; 32],       // keccak256(wallet_address)
    proof_nodes: [[u8; MAX_NODE_LEN]; MAX_PROOF_NODES],
    proof_lens:  [u32; MAX_PROOF_NODES],
    num_nodes:   u32,
    expected_account_rlp: [u8; MAX_ACCOUNT_LEN],
    account_rlp_len: u32,
) {
    // Build key nibbles from account_key
    let mut key_nibbles = [0 as u8; 64];
    for i in 0..32 {
        let (hi, lo) = byte_to_nibbles(account_key[i]);
        key_nibbles[i * 2]     = hi;
        key_nibbles[i * 2 + 1] = lo;
    }

    let mut current_hash = state_root;
    let mut nibble_idx: u32 = 0;

    for node_i in 0..MAX_PROOF_NODES {
        if (node_i as u32) < num_nodes {
            let node = proof_nodes[node_i];
            let node_len = proof_lens[node_i];

            // Verify this node hashes to current_hash
            let node_hash = keccak256_fixed(node, node_len);
            assert(node_hash == current_hash, "MPT node hash mismatch");

            // Decode node as RLP list
            let (payload_start, _payload_len) = rlp_strip_list_prefix(node, 0);

            // Count items to distinguish branch (17) from leaf/extension (2)
            let item_count = rlp_count_items(node, payload_start, _payload_len);

            if item_count == 17 {
                // Branch node: follow the nibble
                let nibble = key_nibbles[nibble_idx] as u32;
                nibble_idx += 1;

                // Walk to the nibble-th item
                let mut item_offset = payload_start;
                for item_i in 0..17 {
                    if (item_i as u32) < nibble {
                        let (_, _, next) = rlp_decode_item(node, item_offset);
                        item_offset = next;
                    }
                }
                // Read the child hash (32 bytes)
                let (val_off, _val_len, _) = rlp_decode_item(node, item_offset);
                for b in 0..32 {
                    current_hash[b] = node[val_off + b as u32];
                }
            } else {
                // Leaf or extension node (2 items)
                // Item 0: compact-encoded path
                let (path_off, path_len, value_off_start) = rlp_decode_item(node, payload_start);

                // Decode compact path
                let path_first = node[path_off];
                let flag = path_first >> 4;
                let is_leaf = (flag == 2) | (flag == 3);
                let odd_len = (flag == 1) | (flag == 3);

                // Consume path nibbles
                let skip_nibbles: u32 = if odd_len {
                    // First nibble is in path_first low bits
                    nibble_idx += 1;
                    (path_len - 1) * 2 + 1
                } else {
                    (path_len - 1) * 2
                };
                nibble_idx += skip_nibbles - if odd_len { 1 } else { 0 };

                // Item 1: value or child hash
                let (val_off, val_len, _) = rlp_decode_item(node, value_off_start);

                if is_leaf {
                    // Leaf: value should match expected account RLP
                    for b in 0..MAX_ACCOUNT_LEN {
                        if (b as u32) < account_rlp_len {
                            assert(
                                node[val_off + b as u32] == expected_account_rlp[b],
                                "Leaf value mismatch"
                            );
                        }
                    }
                } else {
                    // Extension: follow child hash
                    for b in 0..32 {
                        current_hash[b] = node[val_off + b as u32];
                    }
                }
            }
        }
    }
}

//  Main circuit 

fn main(
    //  Public inputs 
    block_number:   pub u64,
    state_root:     pub [u8; 32],
    wallet_address: pub [u8; 20],
    threshold_wei:  pub [u8; 32],
    rule_id:        pub [u8; 32],

    //  Private witnesses 
    // Account RLP: [nonce, balance, storage_root, code_hash]
    account_rlp:         [u8; MAX_ACCOUNT_LEN],
    account_rlp_len:     u32,

    // Merkle-Patricia proof nodes (padded to MAX_NODE_LEN each)
    proof_nodes: [[u8; MAX_NODE_LEN]; MAX_PROOF_NODES],
    proof_lens:  [u32; MAX_PROOF_NODES],
    num_proof_nodes: u32,

    // Block header RLP (to verify state_root)
    header_rlp:     [u8; MAX_HEADER_LEN],
    header_rlp_len: u32,
) {
    //  1. Verify block header contains the claimed state root 
    let extracted_root = extract_state_root(header_rlp, header_rlp_len);
    assert(extracted_root == state_root, "State root mismatch with block header");

    //  2. Compute account key = keccak256(wallet_address) 
    // Pad 20-byte address to 32 bytes for keccak
    let mut addr_padded = [0 as u8; 32];
    for i in 0..20 {
        addr_padded[i + 12] = wallet_address[i];
    }
    // keccak256 of the 20-byte address (not padded  Ethereum uses the raw address)
    let mut addr_bytes = [0 as u8; 32];
    for i in 0..20 {
        addr_bytes[i] = wallet_address[i];
    }
    let account_key = keccak256(addr_bytes, 20);

    //  3. Verify MPT proof  account exists at account_key 
    verify_mpt_proof(
        state_root,
        account_key,
        proof_nodes,
        proof_lens,
        num_proof_nodes,
        account_rlp,
        account_rlp_len,
    );

    //  4. Decode balance from account RLP 
    let balance = decode_balance_from_account_rlp(account_rlp);

    //  5. Assert balance < threshold 
    assert(u256_lt(balance, threshold_wei), "Balance is NOT below threshold");

    //  6. Bind rule_id and block_number into the proof 
    // These are public inputs so they're automatically committed.
    // Explicit constraint to prevent unused variable elimination:
    let _ = rule_id;
    let _ = block_number;
}
