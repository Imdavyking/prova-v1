//go:build js && wasm

package main

import (
	"bytes"
	"fmt"
	"proof-generator/acir"
	"proof-generator/bn254"
	"syscall/js"

	"github.com/consensys/gnark-crypto/ecc"
	ecc_bn254 "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/backend/witness"
	"github.com/consensys/gnark/constraint"
)

var (
	ccs constraint.ConstraintSystem
	pk  groth16.ProvingKey
	w   witness.Witness
)

func initializeCircuit(this js.Value, args []js.Value) interface{} {
	promiseConstructor := js.Global().Get("Promise")
	
	handler := js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		go func() {
			defer func() {
				if r := recover(); r != nil {
					reject.Invoke(js.ValueOf(fmt.Sprintf("Panic: %v", r)))
				}
			}()
			
			if len(args) < 3 {
				reject.Invoke(js.ValueOf("Missing arguments: expected ccsBytes, pkBytes, and witnessBytes"))
				return
			}
			
			// Load CCS
			ccsBytes := make([]byte, args[0].Get("length").Int())
			js.CopyBytesToGo(ccsBytes, args[0])

			ccs = groth16.NewCS(ecc.BN254)
			reader := bytes.NewReader(ccsBytes)
			bytesRead, err := ccs.ReadFrom(reader)
			if err != nil {
				errorMsg := fmt.Sprintf("Failed to load circuit (read %d bytes): %v", bytesRead, err)
				reject.Invoke(js.ValueOf(errorMsg))
				return
			}

			fmt.Printf("Loaded CCS: %d bytes\n", bytesRead)

			// Load proving key
			pkBytes := make([]byte, args[1].Get("length").Int())
			js.CopyBytesToGo(pkBytes, args[1])

			pk = groth16.NewProvingKey(ecc.BN254)
			pkBytesRead, err := pk.ReadFrom(bytes.NewReader(pkBytes))
			if err != nil {
				reject.Invoke(js.ValueOf("Failed to load proving key: " + err.Error()))
				return
			}

			fmt.Printf("Loaded proving key: %d bytes\n", pkBytesRead)

			// Load acirbytes
			acirBytes := make([]byte, args[2].Get("length").Int())
			js.CopyBytesToGo(acirBytes, args[2])

			fmt.Printf("Received ACIR bytes: %d\n", len(acirBytes))

			type E = constraint.U64
			type T = *bn254.BN254Field
			acir, err := acir.LoadACIRFromJSON[T, E](acirBytes)
			
			// Load witness bytes (gzipped JSON bytes)
			witnessBytes := make([]byte, args[3].Get("length").Int())
			js.CopyBytesToGo(witnessBytes, args[3])
			witness, err := acir.GetWitnessFromBytes(witnessBytes, ecc_bn254.ID.ScalarField())
			if err != nil {
				reject.Invoke(js.ValueOf("Failed to load witness: " + err.Error()))
				return
			}

			w = witness

			fmt.Println("Circuit and witness initialized successfully.")
			resolve.Invoke(js.ValueOf("Circuit initialized"))
		}()

		return nil
	})

	return promiseConstructor.New(handler)
}



func generateProof(this js.Value, args []js.Value) interface{} {
	promiseConstructor := js.Global().Get("Promise")
	
	handler := js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		go func() {
			defer func() {
				if r := recover(); r != nil {
					reject.Invoke(js.ValueOf(fmt.Sprintf("Panic: %v", r)))
				}
			}()
			
			// Check if circuit and witness are initialized
			if ccs == nil || pk == nil {
				reject.Invoke(js.ValueOf("Circuit not initialized. Call initCircuit first."))
				return
			}
			
			if w == nil {
				reject.Invoke(js.ValueOf("Witness not loaded. Call initCircuit first."))
				return
			}

			fmt.Println("Generating proof with loaded witness...")

			// Generate proof using the loaded witness
			proof, err := groth16.Prove(ccs, pk, w)
			if err != nil {
				reject.Invoke(js.ValueOf("Proof generation failed: " + err.Error()))
				return
			}

			fmt.Println("Proof generated successfully!")

			// Serialize proof
			var proofBuf bytes.Buffer
			if _, err := proof.WriteRawTo(&proofBuf); err != nil {
				reject.Invoke(js.ValueOf("Failed to serialize proof: " + err.Error()))
				return
			}
			proofBytes := proofBuf.Bytes()

			proofDst := js.Global().Get("Uint8Array").New(len(proofBytes))
			js.CopyBytesToJS(proofDst, proofBytes)

			// Get public witness
			publicWitness, err := w.Public()
			if err != nil {
				reject.Invoke(js.ValueOf("Failed to get public witness: " + err.Error()))
				return
			}

			var pubBuf bytes.Buffer
			if _, err := publicWitness.WriteTo(&pubBuf); err != nil {
				reject.Invoke(js.ValueOf("Failed to serialize public witness: " + err.Error()))
				return
			}
			publicBytes := pubBuf.Bytes()

			publicDst := js.Global().Get("Uint8Array").New(len(publicBytes))
			js.CopyBytesToJS(publicDst, publicBytes)

			resultObj := js.Global().Get("Object").New()
			resultObj.Set("proof", proofDst)
			resultObj.Set("publicInputs", publicDst)
			resultObj.Set("success", true)
			resultObj.Set("proofSize", len(proofBytes))
			resultObj.Set("publicSize", len(publicBytes))
			
			resolve.Invoke(resultObj)
		}()

		return nil
	})

	return promiseConstructor.New(handler)
}

func main() {
	c := make(chan struct{})

	// Register functions to be called from JavaScript
	js.Global().Set("initCircuit", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		return initializeCircuit(this, args)
	}))
	
	js.Global().Set("generateProof", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		return generateProof(this, args)
	}))

	fmt.Println("WASM Proof Generator Ready")
	fmt.Println("Available functions:")
	fmt.Println("  - initCircuit(ccsBytes, pkBytes, witnessBytes)")
	fmt.Println("  - generateProof()")
	
	<-c
}