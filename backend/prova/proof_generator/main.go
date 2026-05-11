//go:build js && wasm

package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"proof-generator/acir"
	"proof-generator/bn254"
	"flag"
	"os"

	"github.com/consensys/gnark-crypto/ecc"
	ecc_bn254 "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
)

func readFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

type ProofOutput struct {
	Proof        string `json:"proof"`
	PublicInputs string `json:"publicInputs"`
}

func main() {
	ccsPath := flag.String("ccs", "", "Path to CCS file")
	pkPath := flag.String("pk", "", "Path to proving key file")
	witnessPath := flag.String("witness", "", "Path to witness file")
	acirPath := flag.String("acir", "", "Path to ACIR JSON file")
	outPath := flag.String("out", "proof.json", "Output proof file")

	flag.Parse()

	if *ccsPath == "" || *pkPath == "" || *witnessPath == "" || *acirPath == "" {
		fmt.Println("Missing required args")
		os.Exit(1)
	}

	fmt.Println("📦 Loading files...")

	// ---------------- CCS ----------------
	ccsBytes, err := readFile(*ccsPath)
	if err != nil {
		panic(err)
	}

	ccs := groth16.NewCS(ecc.BN254)
	_, err = ccs.ReadFrom(bytes.NewReader(ccsBytes))
	if err != nil {
		panic(err)
	}
	fmt.Println("✅ CCS loaded")

	// ---------------- PK ----------------
	pkBytes, err := readFile(*pkPath)
	if err != nil {
		panic(err)
	}

	pk := groth16.NewProvingKey(ecc.BN254)
	_, err = pk.ReadFrom(bytes.NewReader(pkBytes))
	if err != nil {
		panic(err)
	}
	fmt.Println("✅ PK loaded")

	// ---------------- ACIR ----------------
	acirBytes, err := readFile(*acirPath)
	if err != nil {
		panic(err)
	}

	type E = constraint.U64
	type T = *bn254.BN254Field

	parsed, err := acir.LoadACIRFromJSON[T, E](acirBytes)
	if err != nil {
		panic(err)
	}
	fmt.Println("✅ ACIR loaded")

	// ---------------- Witness ----------------
	fmt.Println("📦 Loading witness...")

	w, err := parsed.GetWitness(*witnessPath, ecc_bn254.ID.ScalarField())
	if err != nil {
		panic(err)
	}

	fmt.Println("✅ Witness built")

	// ---------------- Proof ----------------
	fmt.Println("⚡ Generating proof...")

	proof, err := groth16.Prove(ccs, pk, w)
	if err != nil {
		panic(err)
	}

	var proofBuf bytes.Buffer
	_, err = proof.WriteRawTo(&proofBuf)
	if err != nil {
		panic(err)
	}

	// ---------------- Public Inputs ----------------
	publicWitness, err := w.Public()
	if err != nil {
		panic(err)
	}

	var publicBuf bytes.Buffer
	_, err = publicWitness.WriteTo(&publicBuf)
	if err != nil {
		panic(err)
	}

	// ---------------- HEX ENCODING ----------------
	proofHex := hex.EncodeToString(proofBuf.Bytes())
	publicHex := hex.EncodeToString(publicBuf.Bytes())

	output := ProofOutput{
		Proof:        proofHex,
		PublicInputs: publicHex,
	}

	jsonBytes, err := json.Marshal(output)
	if err != nil {
		panic(err)
	}

	err = os.WriteFile(*outPath, jsonBytes, 0644)
	if err != nil {
		panic(err)
	}

	fmt.Println("🎉 Proof saved (JSON HEX) to:", *outPath)
}