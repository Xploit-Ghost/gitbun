import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { execFileSync } from "node:child_process";

import { isGitRepo } from "./git/checkRepo";
import { getStagedFiles } from "./git/getStagedFiles";
import { getDiffStats } from "./git/getDiffStats";
import { detectScope } from "./analyzer/scopeDetector";
import { classifyCommitType } from "./analyzer/typeClassifier";
import { generateSummaryFromResult } from "./analyzer/summarizer";
import {
  filterLowSignalFiles,
  type FileChange,
} from "./analyzer/fileFilter";
import { sortBySignal } from "./analyzer/fileScorer";
import { deduplicateFiles } from "./analyzer/fileDeduplicator";
import { generateCommitMessage } from "./generator/commitGenerator";
import { confirmCommit } from "./ui/interactive";
import { commit } from "./git/commit";
import { enhanceCommit } from "./llm/ollamaEnhancer";
import { loadConfig } from "./config/loadConfig";
import { isOllamaRunning, getBestModel } from "./llm/checkOllama";
import { ValidationError, CancellationError } from "./utils/errors";

interface CliOptions {
  ai?: boolean;
  model?: string;
  auto?: boolean;
  dryRun?: boolean;
  [key: string]: unknown;
}

async function launchStagingUI(options: CliOptions) {
  try {
    const modifiedFiles = execFileSync("git", ["ls-files", "--modified"])
      .toString()
      .split("\n")
      .filter(Boolean);
    const untrackedFiles = execFileSync("git", [
      "ls-files",
      "--others",
      "--exclude-standard",
    ])
      .toString()
      .split("\n")
      .filter(Boolean);
    const unstagedFiles = [...modifiedFiles, ...untrackedFiles];

    if (unstagedFiles.length === 0) {
      console.log("No changes detected to commit.");
      process.exit(0);
    }

    const { filesToStage } = await inquirer.prompt([{
      type: "checkbox",
      name: "filesToStage",
      message: "No files staged. Select files to stage (Space=select, Enter=confirm):",
      choices: unstagedFiles
    }]);

    if (filesToStage.length === 0) {
      console.log("Nothing selected. Exiting.");
      process.exit(0);
    }

    execFileSync("git", ["add", ...filesToStage], { stdio: "inherit" });

    const verified = execFileSync("git", ["diff", "--cached", "--name-only"])
      .toString()
      .trim();

    if (!verified) {
      console.log(chalk.red("Staging failed. No files were staged."));
      process.exit(1);
    }

    await run(options);
  } catch (error) {
    console.error(chalk.red("Failed to launch staging UI:"), error);
    process.exit(1);
  }
}

function getDiffForFile(path: string): string {
  try {
    return execFileSync("git", ["diff", "--cached", "-U0", "--", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export async function run(options: CliOptions) {
  const repo = await isGitRepo();
  if (!repo) {
    throw new ValidationError("Not inside a Git repository.");
  }

  const stagedFiles = await getStagedFiles();

  if (stagedFiles.length === 0) {
    console.log(chalk.yellow("No staged changes found."));
    console.log("Stage changes using: git add <file>");
    await launchStagingUI(options);
    return;
  }

  const spinner = ora();
  let commitMessage = "";

  try {
    const enrichedFiles: FileChange[] = [];
    spinner.start("Analyzing staged changes...");
    for (const file of stagedFiles) {
      const stats = await getDiffStats(file.path);
      enrichedFiles.push({
        path: file.path,
        additions: stats.additions,
        deletions: stats.deletions,
        status: file.status,
      });
    }

    const filteredFiles = filterLowSignalFiles(enrichedFiles);
    const prioritizedCandidates = sortBySignal(filteredFiles, getDiffForFile);
    const prioritizedFiles =
      prioritizedCandidates.length > 0 ? prioritizedCandidates : enrichedFiles;
    const MIN_GROUP_SIZE = 2;
    const deduplicatedResult = deduplicateFiles(
      prioritizedFiles,
      MIN_GROUP_SIZE
    );

    const scope = detectScope(prioritizedFiles.map((f) => f.path));
    const type = await classifyCommitType(prioritizedFiles);
    const summary = generateSummaryFromResult(deduplicatedResult);

    spinner.succeed("Analyzing staged changes...");

    // Load config
    const config = await loadConfig();

    spinner.start("Generating commit message...");
    commitMessage = generateCommitMessage(
      type,
      scope,
      prioritizedFiles,
      config.format
    );
    spinner.succeed("Generating commit message...");

    // AI enhancement (optional)
    if (options.ai) {
      const running = await isOllamaRunning();

      if (!running) {
        console.log(
          chalk.yellow("\nOllama is not running. Using rule-based commit.")
        );
      } else {
        let selectedModel = options.model || config.model;

        if (!selectedModel) {
          selectedModel = (await getBestModel()) || "deepseek-coder:6.7b";
        }

        spinner.start(`Enhancing commit with AI (${selectedModel})...`);

        try {
          commitMessage = await enhanceCommit(
            commitMessage,
            summary,
            selectedModel
          );
          spinner.succeed(`Enhanced commit with AI (${selectedModel})`);
        } catch {
          spinner.fail("AI enhancement failed");
        }
      }
    }
  } catch (error) {
    spinner.fail("Failed during analysis or generation.");
    console.error(error);
    process.exit(1);
  }

  // Dry run: print message and exit without committing
  if (options.dryRun) {
    console.log("\n" + commitMessage + "\n");
    process.exit(0);
  }

  // Confirmation flow
  let finalMessage: string;

  if (options.auto) {
    finalMessage = commitMessage;
  } else {
    const result = await confirmCommit(commitMessage);
    if (!result) {
      throw new CancellationError();
    }
    finalMessage = result;
  }

  const output = await commit(finalMessage);
  console.log("\n" + output);
}
