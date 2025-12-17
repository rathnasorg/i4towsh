#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { processDirectory, getPhotosInDir, getSubdirs } from './index.js';
import { execSync } from 'child_process';

const program = new Command();

function getGitUsername(): string | null {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

program
  .name('i4tow')
  .description('Create photo albums backed by GitHub repos')
  .version('0.0.1')
  .option('-t, --token <token>', 'GitHub token (or set GITHUB_TOKEN env)')
  .option('-u, --username <username>', 'GitHub username (defaults to git config user.name)')
  .option('-d, --dry-run', 'Preview what would be created without making changes')
  .option('-s, --single', 'Force single album mode (current dir = one album)')
  .option('-b, --batch', 'Force batch mode (each subdir = one album)')
  .argument('[directory]', 'Directory to process', process.cwd())
  .action(async (directory: string, opts) => {
    const token = opts.token || process.env.GITHUB_TOKEN;
    const username = opts.username || process.env.GITHUB_USERNAME || getGitUsername();

    if (!token) {
      console.error(chalk.red('Error: GitHub token required'));
      console.error(chalk.gray('  Set GITHUB_TOKEN env or use --token flag'));
      process.exit(1);
    }

    if (!username) {
      console.error(chalk.red('Error: GitHub username required'));
      console.error(chalk.gray('  Set GITHUB_USERNAME env, use --username flag, or configure git user.name'));
      process.exit(1);
    }

    const photos = getPhotosInDir(directory);
    const subdirs = getSubdirs(directory);

    console.log(chalk.blue('\ni4tow - Photo Album Creator\n'));
    console.log(chalk.gray(`Directory: ${directory}`));
    console.log(chalk.gray(`Photos: ${photos.length}`));
    console.log(chalk.gray(`Subdirs: ${subdirs.length}`));
    console.log(chalk.gray(`Username: ${username}`));
    console.log(chalk.gray(`Mode: ${opts.single ? 'single' : opts.batch ? 'batch' : 'auto'}`));
    if (opts.dryRun) {
      console.log(chalk.yellow('DRY RUN - no changes will be made\n'));
    }
    console.log();

    const spinner = ora('Processing...').start();

    try {
      const results = await processDirectory(directory, {
        token,
        username,
        dryRun: opts.dryRun,
        single: opts.single,
        batch: opts.batch,
      });

      spinner.stop();

      if (results.length === 0) {
        console.log(chalk.yellow('No albums created. Make sure the directory contains photos or subdirs with photos.'));
        return;
      }

      console.log(chalk.green(`\n✓ Created ${results.length} album(s):\n`));
      for (const result of results) {
        if (result.success) {
          console.log(chalk.green(`  ✓ ${result.name}`));
          console.log(chalk.gray(`    ${result.repoUrl}`));
        } else {
          console.log(chalk.red(`  ✗ ${result.name}: ${result.error}`));
        }
      }

      if (!opts.dryRun) {
        console.log(chalk.blue('\nNext steps:'));
        console.log(chalk.gray('  1. Wait for GitHub Actions to optimize photos (~2-5 min)'));
        console.log(chalk.gray('  2. View albums at https://<username>.github.io/<repo-name>'));
      }
    } catch (error) {
      spinner.fail('Failed');
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

program.parse();
