#!/usr/bin/env node

/**
 * MCP server for executing local Mathematica (Wolfram Script) code and returning the output.
 * This server helps check mathematical derivations and can generate LaTeX output from LLMs.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

// Promisify execFile for async/await usage
const execFileAsync = promisify(execFile);

/**
 * Create an MCP server with capabilities for tools to execute Mathematica code.
 */
const server = new Server(
  {
    name: "mathematica-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Comprehensive logging
const log = (type: string, message: string, data?: any) => {
  console.error(`[${type}] ${message}`, data ? data : '');
};

const MAX_WOLFRAMSCRIPT_BUFFER = 10 * 1024 * 1024; // 10 MB buffer for wolframscript output

const formatWolframScriptArgsForLog = (args: string[]): string =>
  args
    .map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
    .join(" ");

const runWolframScript = async (args: string[]) => {
  log('Exec', `wolframscript ${formatWolframScriptArgsForLog(args)}`);
  try {
    const { stdout, stderr } = await execFileAsync("wolframscript", args, {
      maxBuffer: MAX_WOLFRAMSCRIPT_BUFFER,
    });
    return { stdout, stderr };
  } catch (error: any) {
    log('Error', 'wolframscript execution failed', {
      args,
      error: error?.message || error,
      stdout: error?.stdout,
      stderr: error?.stderr,
    });
    throw error;
  }
};

const ensureProfilePath = async (profilePath: string) => {
  const directory = path.dirname(profilePath);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.access(profilePath);
  } catch {
    await fs.writeFile(profilePath, "", { encoding: "utf-8" });
  }
};

const normalizeOutputFormat = (format: string) => {
  switch ((format || "text").toLowerCase()) {
    case "latex":
      return "latex";
    case "mathematica":
      return "mathematica";
    case "text":
    default:
      return "text";
  }
};

type WstpSessionMode = "start" | "connect";

interface WstpSession {
  serverBase?: string;
  profilePath: string;
  createdProfile: boolean;
  profileDirectory?: string;
  mode: WstpSessionMode;
  lastEstablished: number;
}

class WstpKernelManager {
  private session: WstpSession | null = null;

  hasActiveSession() {
    return this.session !== null;
  }

  getSession() {
    return this.session;
  }

  private buildBaseArgs(serverBase?: string) {
    const args = ["-wstpserver"];
    if (serverBase && serverBase.trim().length > 0) {
      args.push(serverBase.trim());
    }
    return args;
  }

  private normalizeProfilePath(profilePath: string) {
    return path.resolve(profilePath);
  }

  private async cleanupSessionResources(session: WstpSession) {
    if (session.createdProfile && session.profileDirectory) {
      try {
        await fs.rm(session.profileDirectory, { recursive: true, force: true });
      } catch (error: any) {
        log('Warning', 'Failed to clean up temporary WSTP profile directory', {
          directory: session.profileDirectory,
          error: error?.message || error,
        });
      }
    }
  }

  async startSession(options: {
    serverBase?: string;
    profilePath?: string;
    replaceExisting?: boolean;
  }) {
    const { serverBase, replaceExisting } = options;

    if (this.session) {
      if (!replaceExisting) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "A persistent WSTP session is already active. Set replaceExisting to true to restart it."
        );
      }
      await this.killKernel().catch((error) => {
        log('Warning', 'Failed to stop existing WSTP session during restart', error);
      });
    }

    let createdProfile = false;
    let profileDirectory: string | undefined;
    let resolvedProfilePath: string;

    if (options.profilePath && options.profilePath.trim().length > 0) {
      resolvedProfilePath = this.normalizeProfilePath(options.profilePath);
      await ensureProfilePath(resolvedProfilePath);
    } else {
      profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mathematica-wstp-"));
      resolvedProfilePath = path.join(profileDirectory, "kernel.profile");
      await ensureProfilePath(resolvedProfilePath);
      createdProfile = true;
    }

    const args = [
      ...this.buildBaseArgs(serverBase),
      "-startprofile",
      resolvedProfilePath,
      "-code",
      "Null",
    ];

    await runWolframScript(args);

    const session: WstpSession = {
      serverBase: serverBase?.trim() || undefined,
      profilePath: resolvedProfilePath,
      createdProfile,
      profileDirectory,
      mode: "start",
      lastEstablished: Date.now(),
    };

    this.session = session;
    return session;
  }

  async connectSession(options: {
    serverBase?: string;
    profilePath: string;
    replaceExisting?: boolean;
  }) {
    const { serverBase, profilePath, replaceExisting } = options;

    if (!profilePath || profilePath.trim().length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "profilePath is required to connect to an existing WSTP session"
      );
    }

    if (this.session) {
      if (!replaceExisting) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "A persistent WSTP session is already active. Set replaceExisting to true to replace it."
        );
      }
      await this.killKernel().catch((error) => {
        log('Warning', 'Failed to stop existing WSTP session during replacement', error);
      });
    }

    const resolvedProfilePath = this.normalizeProfilePath(profilePath);
    try {
      await fs.access(resolvedProfilePath);
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Profile file not found at ${resolvedProfilePath}`
      );
    }

    const args = [
      ...this.buildBaseArgs(serverBase),
      "-continueprofile",
      resolvedProfilePath,
      "-code",
      "Null",
    ];

    await runWolframScript(args);

    const session: WstpSession = {
      serverBase: serverBase?.trim() || undefined,
      profilePath: resolvedProfilePath,
      createdProfile: false,
      mode: "connect",
      lastEstablished: Date.now(),
    };

    this.session = session;
    return session;
  }

  async execute(code: string, format: string) {
    if (!this.session) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "No persistent WSTP session is active"
      );
    }

    const args = [
      ...this.buildBaseArgs(this.session.serverBase),
      "-continueprofile",
      this.session.profilePath,
      "-format",
      format,
      "-code",
      code,
    ];

    const { stdout, stderr } = await runWolframScript(args);

    if (stderr) {
      log('Warning', 'Mathematica execution (persistent kernel) produced stderr output', stderr);
    }

    return stdout.trim();
  }

  async killKernel(options?: { profilePath?: string; serverBase?: string }) {
    const activeSession = this.session;
    const profilePath = options?.profilePath
      ? this.normalizeProfilePath(options.profilePath)
      : activeSession?.profilePath;
    const serverBase = options?.serverBase ?? activeSession?.serverBase;

    if (!profilePath) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "profilePath is required when no persistent session is active"
      );
    }

    const args = [
      ...this.buildBaseArgs(serverBase),
      "-continueprofile",
      profilePath,
      "-code",
      "Exit[]",
    ];

    try {
      await runWolframScript(args);
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to terminate Mathematica kernel: ${error.message || error}`
      );
    }

    if (activeSession && this.normalizeProfilePath(profilePath) === activeSession.profilePath) {
      await this.cleanupSessionResources(activeSession);
      this.session = null;
    }
  }
}

const wstpManager = new WstpKernelManager();

log('Setup', 'Initializing Mathematica MCP server...');

/**
 * Handler that lists available tools.
 * Exposes tools for executing Mathematica code and converting to LaTeX.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('Tools', 'Listing available tools');
  return {
    tools: [
      {
        name: "execute_mathematica",
        description: "Execute Mathematica code and return the result",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "Mathematica code to execute"
            },
            format: {
              type: "string",
              description: "Output format (text, latex, or mathematica)",
              enum: ["text", "latex", "mathematica"],
              default: "text"
            }
          },
          required: ["code"]
        }
      },
      {
        name: "verify_derivation",
        description: "Verify a mathematical derivation step by step",
        inputSchema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "Array of mathematical expressions representing steps in a derivation",
              items: {
                type: "string"
              }
            },
            format: {
              type: "string",
              description: "Output format (text, latex, or mathematica)",
              enum: ["text", "latex", "mathematica"],
              default: "text"
            }
          },
          required: ["steps"]
        }
      },
      {
        name: "establish_wstp_session",
        description: "Establish or connect to a persistent Mathematica kernel via WSTP",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              description: "Whether to start a new kernel or connect to an existing one",
              enum: ["start", "connect"],
              default: "start"
            },
            serverBase: {
              type: "string",
              description: "Optional WSTP server base (e.g., port, host@port, or wstp:// URL)"
            },
            profilePath: {
              type: "string",
              description: "Path to the WSTP profile file used to persist the kernel identifier"
            },
            replaceExisting: {
              type: "boolean",
              description: "Replace the currently active persistent session if one is active",
              default: false
            }
          }
        }
      },
      {
        name: "kill_mathematica_kernel",
        description: "Terminate the Mathematica kernel associated with the active or specified WSTP profile",
        inputSchema: {
          type: "object",
          properties: {
            profilePath: {
              type: "string",
              description: "Optional profile path to terminate; defaults to the active session"
            },
            serverBase: {
              type: "string",
              description: "Optional WSTP server base if different from the active session"
            }
          }
        }
      }
    ]
  };
});

/**
 * Check if Mathematica (wolframscript) is installed and accessible
 */
async function checkMathematicaInstallation(): Promise<boolean> {
  try {
    log('Setup', 'Checking Mathematica installation...');
    await runWolframScript(["-help"]);
    log('Setup', 'Mathematica installation verified');
    return true;
  } catch (error: any) {
    log('Error', 'Mathematica not found or not accessible', error);
    return false;
  }
}

/**
 * Execute Mathematica code and return the result
 */
async function executeMathematicaCode(code: string, format: string = "text"): Promise<string> {
  const normalizedFormat = normalizeOutputFormat(format);
  const preview = code.substring(0, 100) + (code.length > 100 ? '...' : '');

  try {
    if (wstpManager.hasActiveSession()) {
      log('API', 'Executing Mathematica code via persistent WSTP kernel', { code: preview });
      const result = await wstpManager.execute(code, normalizedFormat);
      log('API', 'Mathematica execution (persistent kernel) completed successfully');
      return result;
    }

    log('API', 'Executing Mathematica code via wolframscript', { code: preview });
    const args = ["-format", normalizedFormat, "-code", code];
    const { stdout, stderr } = await runWolframScript(args);

    if (stderr) {
      log('Warning', 'Mathematica execution produced stderr output', stderr);
    }

    log('API', 'Mathematica execution completed successfully');
    return stdout.trim();
  } catch (error: any) {
    log('Error', 'Failed to execute Mathematica code', error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to execute Mathematica code: ${error.message}`
    );
  }
}

/**
 * Verify a mathematical derivation by checking each step
 */
async function verifyDerivation(steps: string[], format: string = "text"): Promise<string> {
  if (steps.length < 2) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "At least two steps are required for a derivation"
    );
  }

  try {
    log('API', 'Verifying mathematical derivation', { steps: steps.length });

    // Create Mathematica code to verify each step
    const verificationCode = `
      steps = ${JSON.stringify(steps)};
      results = {};
      
      (* Check if each step follows from the previous *)
      For[i = 2, i <= Length[steps], i++,
        prev = ToExpression[steps[[i-1]]];
        current = ToExpression[steps[[i]]];
        
        (* Check if they're mathematically equivalent *)
        equivalent = Simplify[prev == current];
        
        (* Store the result *)
        AppendTo[results, {
          "step" -> i,
          "expression" -> steps[[i]],
          "equivalent" -> equivalent,
          "simplification" -> Simplify[current]
        }];
      ];
      
      (* Format the results *)
      FormattedResults = "Derivation Verification Results:\\n\\n";
      
      For[i = 1, i <= Length[results], i++,
        result = results[[i]];
        stepNum = result["step"];
        expr = result["expression"];
        isEquiv = result["equivalent"];
        
        FormattedResults = FormattedResults <> 
          "Step " <> ToString[stepNum] <> ": " <> expr <> "\\n" <>
          "  Valid: " <> ToString[isEquiv] <> "\\n\\n";
      ];
      
      FormattedResults
    `;

    return await executeMathematicaCode(verificationCode, format);
  } catch (error: any) {
    log('Error', 'Failed to verify derivation', error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to verify derivation: ${error.message}`
    );
  }
}

/**
 * Handler for tool execution.
 * Handles execute_mathematica, verify_derivation, and kernel management tools.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // First check if Mathematica is installed
  const mathematicaAvailable = await checkMathematicaInstallation();
  if (!mathematicaAvailable) {
    return {
      content: [{
        type: "text",
        text: "Error: Mathematica (wolframscript) is not installed or not accessible. Please make sure Mathematica is installed and wolframscript is in your PATH."
      }],
      isError: true
    };
  }

  switch (request.params.name) {
    case "execute_mathematica": {
      log('Tool', 'Executing execute_mathematica tool');
      const code = String(request.params.arguments?.code);
      const format = String(request.params.arguments?.format || "text");

      if (!code) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Mathematica code is required"
        );
      }

      try {
        const result = await executeMathematicaCode(code, format);

        return {
          content: [{
            type: "text",
            text: result
          }]
        };
      } catch (error: any) {
        log('Error', 'Tool execution failed', error);
        return {
          content: [{
            type: "text",
            text: `Error executing Mathematica code: ${error.message}`
          }],
          isError: true
        };
      }
    }

    case "verify_derivation": {
      log('Tool', 'Executing verify_derivation tool');
      const steps = request.params.arguments?.steps as string[];
      const format = String(request.params.arguments?.format || "text");

      if (!steps || !Array.isArray(steps) || steps.length < 2) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "At least two derivation steps are required"
        );
      }

      try {
        const result = await verifyDerivation(steps, format);

        return {
          content: [{
            type: "text",
            text: result
          }]
        };
      } catch (error: any) {
        log('Error', 'Tool execution failed', error);
        return {
          content: [{
            type: "text",
            text: `Error verifying derivation: ${error.message}`
          }],
          isError: true
        };
      }
    }

    case "establish_wstp_session": {
      log('Tool', 'Executing establish_wstp_session tool');
      const rawMode = request.params.arguments?.mode;
      const mode = String(rawMode || "start").toLowerCase() as "start" | "connect";
      const serverBaseRaw = request.params.arguments?.serverBase;
      const serverBase = serverBaseRaw !== undefined && serverBaseRaw !== null
        ? String(serverBaseRaw).trim() || undefined
        : undefined;
      const profilePathRaw = request.params.arguments?.profilePath;
      const profilePathTrimmed = profilePathRaw !== undefined && profilePathRaw !== null
        ? String(profilePathRaw).trim()
        : undefined;
      const profilePath = profilePathTrimmed && profilePathTrimmed.length > 0 ? profilePathTrimmed : undefined;
      const replaceExistingRaw = request.params.arguments?.replaceExisting;
      const replaceExisting = typeof replaceExistingRaw === "string"
        ? replaceExistingRaw.toLowerCase() === "true"
        : Boolean(replaceExistingRaw);

      if (mode !== "start" && mode !== "connect") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unsupported mode '${mode}'. Expected 'start' or 'connect'.`
        );
      }

      if (mode === "connect" && !profilePath) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "profilePath is required when mode is 'connect'"
        );
      }

      try {
        const session =
          mode === "connect"
            ? await wstpManager.connectSession({
                serverBase,
                profilePath: profilePath as string,
                replaceExisting,
              })
            : await wstpManager.startSession({
                serverBase,
                profilePath,
                replaceExisting,
              });

        const details = [
          `Mode: ${session.mode}`,
          `Profile path: ${session.profilePath}`,
          `Server base: ${session.serverBase ?? "(default)"}`,
          `Profile source: ${session.createdProfile ? "created" : "existing"}`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Persistent Mathematica kernel ${
                session.mode === "start" ? "started" : "connected"
              } successfully.\n${details}`,
            },
          ],
        };
      } catch (error: any) {
        log('Error', 'Failed to establish persistent WSTP session', error);
        return {
          content: [
            {
              type: "text",
              text: `Error establishing WSTP session: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "kill_mathematica_kernel": {
      log('Tool', 'Executing kill_mathematica_kernel tool');
      const profilePathRaw = request.params.arguments?.profilePath;
      const profilePathTrimmed = profilePathRaw !== undefined && profilePathRaw !== null
        ? String(profilePathRaw).trim()
        : undefined;
      const profilePath = profilePathTrimmed && profilePathTrimmed.length > 0 ? profilePathTrimmed : undefined;
      const serverBaseRaw = request.params.arguments?.serverBase;
      const serverBase = serverBaseRaw !== undefined && serverBaseRaw !== null
        ? String(serverBaseRaw).trim() || undefined
        : undefined;

      try {
        await wstpManager.killKernel({ profilePath, serverBase });
        return {
          content: [
            {
              type: "text",
              text: "Mathematica kernel terminated successfully.",
            },
          ],
        };
      } catch (error: any) {
        log('Error', 'Failed to terminate Mathematica kernel', error);
        return {
          content: [
            {
              type: "text",
              text: `Error terminating Mathematica kernel: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      log('Error', `Unknown tool: ${request.params.name}`);
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  try {
    log('Setup', 'Starting Mathematica MCP server...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Setup', 'Mathematica MCP server running on stdio');

    // Set up error handling
    process.on('uncaughtException', (error: Error) => {
      log('Error', 'Uncaught exception', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      log('Error', 'Unhandled rejection', reason);
    });

    process.on('SIGINT', async () => {
      log('Setup', 'Shutting down Mathematica MCP server...');
      await server.close();
      process.exit(0);
    });
  } catch (error: any) {
    log('Error', 'Failed to start server', error);
    process.exit(1);
  }
}

main().catch((error: any) => {
  log('Error', 'Server error', error);
  process.exit(1);
});
