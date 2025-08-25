import fs from "fs";
import arg from "arg";
import type { Client } from "@phala/cloud";
import { createClient, getAvailableNodes, getKmsList } from "@phala/cloud";
import { provisionCvm, commitCvmProvision, deployAppAuth } from "@phala/cloud";
import type { Chain } from "viem";

const typed = {
  "--name": String,
  "--vcpu": Number,
  "--memory": Number,
  "--disk-size": Number,
  "--private-key": String,
  "--rpc-url": String,
  "--kms-id": String,
  "--count": Number,
  "--node-id": Number,
};

async function main(args: arg.Result<typeof typed>) {
  if (!args["_"] || args["_"].length === 0 || !args["_"][0]) {
    console.log("Usage: bun run deploy-multi.ts <path_to_docker_compose_yml> --private-key <key> --rpc-url <url> --kms-id <id>");
    process.exit(1);
  }

  const docker_compose_path = args["_"][0];
  if (!fs.existsSync(docker_compose_path)) {
    console.log("File not found:", docker_compose_path);
    process.exit(1);
  }
  const docker_compose_yml = fs.readFileSync(docker_compose_path, "utf8");

  const privateKey = args["--private-key"] || process.env.PRIVATEKEY;
  if (!privateKey) {
    console.log("--private-key or PRIVATEKEY environment variable is required");
    process.exit(1);
  }

  const rpcUrl = args["--rpc-url"] || process.env.RPC_URL;
  if (!rpcUrl) {
    console.log("--rpc-url or RPC_URL environment variable is required");
    process.exit(1);
  }

  const kmsId = args["--kms-id"];
  if (!kmsId) {
    console.log("--kms-id is required");
    process.exit(1);
  }

  const name = args["--name"] || "multi-app";
  const vcpu = args["--vcpu"] || 1;
  const memory = args["--memory"] || 1024;
  const diskSize = args["--disk-size"] || 10;
  const count = args["--count"] || 2;

  const client = createClient({
    apiKey: process.env.PHALA_CLOUD_API_KEY
  });

  // Get available nodes and find prod7
  const nodes = await getAvailableNodes(client);
  const target = nodes.nodes.find((node) => node.name === "prod7");
  if (!target) {
    throw new Error("Node prod7 not found");
  }
  const image = target.images[0];
  if (!image) {
    throw new Error("No available OS images found in the node prod7");
  }

  // Get KMS info
  const kms_list = await getKmsList(client);
  const kms = kms_list.items.find((k) => k.slug === kmsId || k.id === kmsId);
  if (!kms) {
    throw new Error(`KMS ${kmsId} not found`);
  }

  // Step 1: Create base app compose config
  const app_compose = {
    name: name,
    compose_file: {
      docker_compose_file: docker_compose_yml,
    },
    vcpu: vcpu,
    memory: memory,
    disk_size: diskSize,
    node_id: target.teepod_id,
    image: image.name,
    ...(kms.slug && { kms_id: kms.slug }),
  };

  // Step 2: Deploy first instance and create contract
  console.log("Deploying first instance and creating contract...");
  const provision1 = await provisionCvm(client, app_compose);

  // Deploy contract
  const deployed_contract = await deployAppAuth({
    chain: kms.chain as Chain,
    rpcUrl: rpcUrl,
    kmsContractAddress: kms.kms_contract_address!,
    privateKey: privateKey as `0x${string}`,
    deviceId: target.device_id!,
    composeHash: provision1.compose_hash,
  });

  console.log("Contract deployed:", deployed_contract);

  // Commit first instance
  const result1 = await commitCvmProvision(client, {
    app_id: deployed_contract.appId,
    compose_hash: provision1.compose_hash,
    kms_id: kmsId,
    contract_address: deployed_contract.appAuthAddress,
    deployer_address: deployed_contract.deployer,
  });

  console.log("First instance deployed:", result1);

  // Step 3: Deploy additional instances using same app ID
  for (let i = 1; i < count; i++) {
    console.log(`Deploying instance ${i + 1}...`);
    const provisionN = await provisionCvm(client, app_compose);
    const resultN = await commitCvmProvision(client, {
      app_id: deployed_contract.appId,
      compose_hash: provisionN.compose_hash,
      kms_id: kmsId,
      contract_address: deployed_contract.appAuthAddress,
      deployer_address: deployed_contract.deployer,
    });
    console.log(`Instance ${i + 1} deployed:`, resultN);
  }
}

main(arg(typed))
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.trace(error);
    process.exit(1);
  });
