import { createMockVaultApi } from "../../src/api/mockVault";
import { describeVaultContract, describeGitContract, describeAiContract, describeReviewContract } from "./vaultApiContract";

describeVaultContract("mock", createMockVaultApi);
describeGitContract("mock", createMockVaultApi);
describeAiContract("mock", createMockVaultApi);
describeReviewContract("mock", createMockVaultApi);
