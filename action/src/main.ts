import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as process from "process";

import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { exec } from "@actions/exec";

import * as glob from "glob";
import { compare, CompareOperator } from "compare-versions";

const compareVersions = (v1: string, op: CompareOperator, v2: string): boolean => {
  return compare(v1, v2, op);
};

const setOrAppendEnvVar = (name: string, value: string): void => {
  const oldValue = process.env[name];
  let newValue = value;
  if (oldValue) {
    newValue = `${oldValue}:${newValue}`;
  }
  core.exportVariable(name, newValue);
};

const dirExists = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (err) {
    return false;
  }
};

// Names of directories for tools (tools_conan & tools_ninja) that include binaries in the
// base directory instead of a bin directory (ie 'Tools/Conan', not 'Tools/Conan/bin')
const binlessToolDirectories = ["Conan", "Ninja"];

const toolsPaths = (installDir: string): string[] => {
  const binlessPaths: string[] = binlessToolDirectories
    .map((dir) => path.join(installDir, "Tools", dir))
    .filter((dir) => dirExists(dir));
  return [
    "Tools/**/bin",
    "*.app/Contents/MacOS",
    "*.app/**/bin",
    "Tools/*/*.app/Contents/MacOS",
    "Tools/*/*.app/**/bin",
  ]
    .flatMap((p: string): string[] => glob.sync(`${installDir}/${p}`))
    .concat(binlessPaths)
    .map((p) => path.resolve(p));
};

const pythonCommand = (command: string, args: readonly string[]): string => {
  const python = process.platform === "win32" ? "python" : "python3";
  return `${python} -m ${command} ${args.join(" ")}`;
};

const execPython = async (command: string, args: readonly string[]): Promise<number> => {
  return exec(pythonCommand(command, args));
};

const execDotNet = async (projectDir: string, args: readonly string[]): Promise<number> => {
  return exec("dotnet", [...args], { cwd: projectDir });
};

const flaggedList = (flag: string, listArgs: readonly string[]): string[] => {
  return listArgs.length ? [flag, ...listArgs] : [];
};

const locateQtArchDir = (installDir: string, host: string): [string, boolean] => {
  // For 6.4.2/gcc, qmake is at 'installDir/6.4.2/gcc_64/bin/qmake'.
  // This makes a list of all the viable arch directories that contain a qmake file.
  const qtArchDirs = glob
    .sync(`${installDir}/[0-9]*/*/bin/qmake*`)
    .map((s) => path.resolve(s, "..", ".."));

  // For Qt6 mobile and wasm installations, and Qt6 Windows on ARM cross-compiled installations,
  // a standard desktop Qt installation must exist alongside the requested architecture.
  // In these cases, we must select the first item that ends with 'android*', 'ios', 'wasm*' or 'msvc*_arm64'.
  const requiresParallelDesktop = qtArchDirs.filter((archPath) => {
    const archDir = path.basename(archPath);
    const versionDir = path.basename(path.join(archPath, ".."));
    return (
      versionDir.match(/^6\.\d+\.\d+$/) &&
      (archDir.match(/^(android.*|ios|wasm.*)$/) ||
        (archDir.match(/^msvc.*_arm64$/) && host !== "windows_arm64"))
    );
  });
  if (requiresParallelDesktop.length) {
    // NOTE: if multiple mobile/wasm installations coexist, this may not select the desired directory
    return [requiresParallelDesktop[0], true];
  } else if (!qtArchDirs.length) {
    throw Error(`Failed to locate a Qt installation directory in  ${installDir}`);
  } else {
    // NOTE: if multiple Qt installations exist, this may not select the desired directory
    return [qtArchDirs[0], false];
  }
};

class Inputs {
  readonly host: "windows" | "windows_arm64" | "mac" | "linux" | "linux_arm64" | "all_os";
  readonly target: "desktop" | "android" | "ios" | "wasm";
  readonly version: string;
  readonly arch: string;
  readonly dir: string;
  readonly modules: string[];
  readonly extensions: string[];
  readonly archives: string[];
  readonly autodesktop: boolean;
  readonly tools: string[];
  readonly addToolsToPath: boolean;
  readonly mirror: string;
  readonly nohash: boolean;
  readonly extra: string[];

  readonly src: boolean;
  readonly srcArchives: string[];

  readonly doc: boolean;
  readonly docArchives: string[];
  readonly docModules: string[];

  readonly example: boolean;
  readonly exampleArchives: string[];
  readonly exampleModules: string[];

  readonly installDeps: boolean | "nosudo";
  readonly cache: boolean;
  readonly cacheKeyPrefix: string;
  readonly isInstallQtBinaries: boolean;
  readonly setEnv: boolean;

  readonly aqtSource: string;
  readonly aqtVersion: string;
  readonly py7zrVersion: string;
  readonly useNaqt: boolean;
  readonly naqtViaGit: boolean;

  readonly useOfficial: boolean;
  readonly email: string;
  readonly pw: string;

  constructor() {
    const host = core.getInput("host");
    // Set host automatically if omitted
    if (!host) {
      switch (process.platform) {
        case "win32": {
          this.host = process.arch === "arm64" ? "windows_arm64" : "windows";
          break;
        }
        case "darwin": {
          this.host = "mac";
          break;
        }
        default: {
          this.host = process.arch === "arm64" ? "linux_arm64" : "linux";
          break;
        }
      }
    } else {
      // Make sure host is one of the allowed values
      if (
        host === "windows" ||
        host === "windows_arm64" ||
        host === "mac" ||
        host === "linux" ||
        host === "linux_arm64" ||
        host === "all_os"
      ) {
        this.host = host;
      } else {
        throw TypeError(
          `host: "${host}" is not one of "windows" | "windows_arm64" | "mac" | "linux" | "linux_arm64" | "all_os"`
        );
      }
    }

    const target = core.getInput("target");
    // Make sure target is one of the allowed values
    if (target === "desktop" || target === "android" || target === "ios" || target === "wasm") {
      this.target = target;
    } else {
      throw TypeError(`target: "${target}" is not one of "desktop" | "android" | "ios" | "wasm"`);
    }

    // An attempt to sanitize non-straightforward version number input
    this.version = core.getInput("version");

    this.arch = core.getInput("arch");
    // Set arch automatically if omitted
    if (!this.arch) {
      if (this.target === "android") {
        if (
          compareVersions(this.version, ">=", "5.14.0") &&
          compareVersions(this.version, "<", "6.0.0")
        ) {
          this.arch = "android";
        } else {
          this.arch = "android_armv7";
        }
      } else if (this.host === "windows") {
        if (compareVersions(this.version, ">=", "6.8.0")) {
          this.arch = "win64_msvc2022_64";
        } else if (compareVersions(this.version, ">=", "5.15.0")) {
          this.arch = "win64_msvc2019_64";
        } else if (compareVersions(this.version, "<", "5.6.0")) {
          this.arch = "win64_msvc2013_64";
        } else if (compareVersions(this.version, "<", "5.9.0")) {
          this.arch = "win64_msvc2015_64";
        } else {
          this.arch = "win64_msvc2017_64";
        }
      } else if (this.host === "windows_arm64") {
        this.arch = "win64_msvc2022_arm64";
      }
    }

    const dir = core.getInput("dir") || process.env.RUNNER_WORKSPACE;
    if (!dir) {
      throw TypeError(`"dir" input may not be empty`);
    }
    this.dir = path.resolve(dir, "Qt");

    this.modules = Inputs.getStringArrayInput("modules");

    this.extensions = Inputs.getStringArrayInput("extensions");

    this.archives = Inputs.getStringArrayInput("archives");

    this.autodesktop = Inputs.getBoolInput("autodesktop");

    this.tools = Inputs.getStringArrayInput("tools").map(
      // The tools inputs have the tool name, variant, and arch delimited by a comma
      // aqt expects spaces instead
      (tool: string): string => tool.replace(/,/g, " ")
    );

    this.addToolsToPath = Inputs.getBoolInput("add-tools-to-path");

    this.mirror = core.getInput("mirror");

    this.nohash = Inputs.getBoolInput("nohash");

    this.extra = Inputs.getStringArrayInput("extra");

    const installDeps = core.getInput("install-deps").toLowerCase();
    if (installDeps === "nosudo") {
      this.installDeps = "nosudo";
    } else {
      this.installDeps = installDeps === "true";
    }

    this.cache = Inputs.getBoolInput("cache");

    this.cacheKeyPrefix = core.getInput("cache-key-prefix");

    this.isInstallQtBinaries =
      !Inputs.getBoolInput("tools-only") && !Inputs.getBoolInput("no-qt-binaries");

    this.setEnv = Inputs.getBoolInput("set-env");

    this.aqtSource = core.getInput("aqtsource");
    this.aqtVersion = core.getInput("aqtversion");

    this.py7zrVersion = core.getInput("py7zrversion");

    this.useOfficial = Inputs.getBoolInput("use-official");
    this.email = core.getInput("email");
    this.pw = core.getInput("pw");

    this.src = Inputs.getBoolInput("source");
    this.srcArchives = Inputs.getStringArrayInput("src-archives");

    this.doc = Inputs.getBoolInput("documentation");
    this.docModules = Inputs.getStringArrayInput("doc-modules");
    this.docArchives = Inputs.getStringArrayInput("doc-archives");

    this.example = Inputs.getBoolInput("examples");
    this.exampleModules = Inputs.getStringArrayInput("example-modules");
    this.exampleArchives = Inputs.getStringArrayInput("example-archives");

    this.useNaqt = Inputs.getBoolInput("use-naqt");
    this.naqtViaGit = Inputs.getBoolInput("naqt-via-git");
  }

  public get cacheKey(): string {
    let cacheKey = this.cacheKeyPrefix;
    for (const keyStringArray of [
      [
        this.host,
        os.release(),
        this.target,
        this.arch,
        this.version,
        this.dir,
        this.py7zrVersion,
        this.aqtSource,
        this.aqtVersion,
        this.useOfficial ? "official" : "",
      ],
      this.modules,
      this.extensions,
      this.archives,
      this.extra,
      this.tools,
      this.src ? "src" : "",
      this.srcArchives,
      this.doc ? "doc" : "",
      this.docArchives,
      this.docModules,
      this.example ? "example" : "",
      this.exampleArchives,
      this.exampleModules,
    ]) {
      for (const keyString of keyStringArray) {
        if (keyString) {
          cacheKey += `-${keyString}`;
        }
      }
    }
    // Cache keys cannot contain commas
    cacheKey = cacheKey.replace(/,/g, "-");
    // Cache keys cannot be larger than 512 characters
    const maxKeyLength = 512;
    if (cacheKey.length > maxKeyLength) {
      const hashedCacheKey = crypto.createHash("sha256").update(cacheKey).digest("hex");
      cacheKey = `${this.cacheKeyPrefix}-${hashedCacheKey}`;
    }
    return cacheKey;
  }

  private static getBoolInput(name: string): boolean {
    return core.getInput(name).toLowerCase() === "true";
  }
  private static getStringArrayInput(name: string): string[] {
    const content = core.getInput(name);
    return content ? content.split(" ") : [];
  }
}

const run = async (): Promise<void> => {
  const inputs = new Inputs();

  // Qt installer assumes basic requirements that are not installed by
  // default on Ubuntu.
  if (process.platform === "linux") {
    if (inputs.installDeps) {
      const dependencies = [
        "build-essential",
        "libgl1-mesa-dev",
        "libgstreamer-gl1.0-0",
        "libpulse-dev",
        "libxcb-glx0",
        "libxcb-icccm4",
        "libxcb-image0",
        "libxcb-keysyms1",
        "libxcb-randr0",
        "libxcb-render-util0",
        "libxcb-render0",
        "libxcb-shape0",
        "libxcb-shm0",
        "libxcb-sync1",
        "libxcb-util1",
        "libxcb-xfixes0",
        "libxcb-xinerama0",
        "libxcb1",
        "libxkbcommon-dev",
        "libxkbcommon-x11-0",
        "libxcb-xkb-dev",
      ];

      // Qt 6.5.0 adds this requirement:
      // https://code.qt.io/cgit/qt/qtreleasenotes.git/about/qt/6.5.0/release-note.md
      if (compareVersions(inputs.version, ">=", "6.5.0")) {
        dependencies.push("libxcb-cursor0");
      }

      const updateCommand = "apt-get update";
      const installCommand = `apt-get install ${dependencies.join(" ")} -y`;
      if (inputs.installDeps === "nosudo") {
        await exec(updateCommand);
        await exec(installCommand);
      } else {
        await exec(`sudo ${updateCommand}`);
        await exec(`sudo ${installCommand}`);
      }
    }
  }

  // Restore internal cache
  let internalCacheHit = false;
  if (inputs.cache) {
    const cacheHitKey = await cache.restoreCache([inputs.dir], inputs.cacheKey);
    if (cacheHitKey) {
      core.info(`Automatic cache hit with key "${cacheHitKey}"`);
      internalCacheHit = true;
    } else {
      core.info("Automatic cache miss, will cache this run");
    }
  }

  // Install Qt and tools if not cached
  if (!internalCacheHit) {
    const tempDir = os.tmpdir();
    const naqtDir = path.join(tempDir, inputs.naqtViaGit ? "naqt-src" : "naqt-bin");

    if (inputs.useNaqt && inputs.isInstallQtBinaries && !dirExists(naqtDir)) {
      const execOpt = { cwd: tempDir };
      if (inputs.naqtViaGit) {
        const gitUrl = "https://github.com/jdpurcell/naqt.git";
        await exec(`git clone --recurse-submodules ${gitUrl} naqt-src`, [], execOpt);
        const env = process.env;
        env.DOTNET_NOLOGO = "true";
        env.DOTNET_CLI_TELEMETRY_OPTOUT = "true";
        env.DOTNET_ADD_GLOBAL_TOOLS_TO_PATH = "false";
        env.DOTNET_GENERATE_ASPNET_CERTIFICATE = "false";
        env.DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE = "true";
      } else {
        const zipUrl = "https://github.com/jdpurcell/naqt/releases/download/latest/naqt.zip";
        await exec(`curl -sL ${zipUrl} -o naqt.zip`, [], execOpt);
        await exec("unzip -q naqt.zip -d naqt-bin", [], execOpt);
        await fs.promises.unlink(path.join(tempDir, "naqt.zip"));
      }
    }

    if (!inputs.useNaqt || inputs.src || inputs.doc || inputs.example || inputs.tools.length) {
      // Install dependencies via pip
      await execPython("pip install", ["setuptools>=70.1.0", `"py7zr${inputs.py7zrVersion}"`]);

      // Install aqtinstall separately: allows aqtinstall to override py7zr if required
      if (inputs.aqtSource.length > 0) {
        await execPython("pip install", [`"${inputs.aqtSource}"`]);
      } else {
        await execPython("pip install", [`"aqtinstall${inputs.aqtVersion}"`]);
      }
    }

    const execInstallerCommand = async (args: readonly string[]): Promise<number> => {
      if (inputs.useNaqt && args[0] === "install-qt") {
        const baseArgs = inputs.naqtViaGit ? ["run", "--"] : ["naqt.dll"];
        return execDotNet(naqtDir, [...baseArgs, ...args]);
      } else {
        return execPython("aqt", args);
      }
    };

    // Install Qt
    if (inputs.isInstallQtBinaries) {
      if (inputs.useOfficial && inputs.email && inputs.pw) {
        const qtArgs = [
          inputs.target,
          ...(inputs.arch ? [inputs.arch] : []),
          inputs.version,
          ...["--outputdir", inputs.dir],
          ...["--email", inputs.email],
          ...["--pw", inputs.pw],
          ...flaggedList("--modules", inputs.modules),
          ...inputs.extra,
        ];
        await execInstallerCommand(["install-qt-official", ...qtArgs]);
      } else {
        const qtArgs = [
          inputs.host,
          inputs.target,
          inputs.version,
          ...(inputs.arch ? [inputs.arch] : []),
          ...(inputs.autodesktop ? ["--autodesktop"] : []),
          ...["--outputdir", inputs.dir],
          ...flaggedList("--modules", [
            ...inputs.modules,
            ...(inputs.useNaqt ? [] : inputs.extensions),
          ]),
          ...flaggedList("--extensions", [...(inputs.useNaqt ? inputs.extensions : [])]),
          ...flaggedList("--archives", inputs.archives),
          ...(inputs.mirror ? [inputs.useNaqt ? "--mirror" : "--base", inputs.mirror] : []),
          ...(inputs.nohash ? [inputs.useNaqt ? "--nohash" : "--UNSAFE-ignore-hash"] : []),
          ...inputs.extra,
        ];
        await execInstallerCommand(["install-qt", ...qtArgs]);
      }
    }

    const installSrcDocExamples = async (
      flavor: "src" | "doc" | "example",
      archives: readonly string[],
      modules: readonly string[]
    ): Promise<void> => {
      const qtArgs = [
        inputs.host,
        // Aqtinstall < 2.0.4 requires `inputs.target` here, but that's deprecated
        inputs.version,
        ...["--outputdir", inputs.dir],
        ...flaggedList("--archives", archives),
        ...flaggedList("--modules", modules),
        ...inputs.extra,
      ];
      await execInstallerCommand([`install-${flavor}`, ...qtArgs]);
    };

    // Install source, docs, & examples
    if (inputs.src) {
      await installSrcDocExamples("src", inputs.srcArchives, []);
    }
    if (inputs.doc) {
      await installSrcDocExamples("doc", inputs.docArchives, inputs.docModules);
    }
    if (inputs.example) {
      await installSrcDocExamples("example", inputs.exampleArchives, inputs.exampleModules);
    }

    // Install tools
    for (const tool of inputs.tools) {
      const toolArgs = [inputs.host, inputs.target, tool];
      toolArgs.push("--outputdir", inputs.dir);
      toolArgs.push(...inputs.extra);
      await execInstallerCommand(["install-tool", ...toolArgs]);
    }
  }

  // Save automatic cache
  if (!internalCacheHit && inputs.cache) {
    const cacheId = await cache.saveCache([inputs.dir], inputs.cacheKey);
    core.info(`Automatic cache saved with id ${cacheId}`);
  }

  // Add tools to path
  if (inputs.addToolsToPath && inputs.tools.length) {
    toolsPaths(inputs.dir).forEach(core.addPath);
  }

  // Set environment variables/outputs for tools
  if (inputs.tools.length && inputs.setEnv) {
    core.exportVariable("IQTA_TOOLS", path.resolve(inputs.dir, "Tools"));
  }
  // Set environment variables/outputs for binaries
  if (inputs.isInstallQtBinaries) {
    const [qtPath, requiresParallelDesktop] = locateQtArchDir(inputs.dir, inputs.host);
    // Set outputs
    core.setOutput("qtPath", qtPath);

    // Set env variables
    if (inputs.setEnv) {
      if (process.platform === "linux") {
        setOrAppendEnvVar("LD_LIBRARY_PATH", path.resolve(qtPath, "lib"));
      }
      if (process.platform !== "win32") {
        setOrAppendEnvVar("PKG_CONFIG_PATH", path.resolve(qtPath, "lib", "pkgconfig"));
      }
      // If less than qt6, set Qt5_DIR variable
      if (compareVersions(inputs.version, "<", "6.0.0")) {
        core.exportVariable("Qt5_DIR", path.resolve(qtPath, "lib", "cmake"));
      }
      core.exportVariable("QT_ROOT_DIR", qtPath);
      core.exportVariable("QT_PLUGIN_PATH", path.resolve(qtPath, "plugins"));
      core.exportVariable("QML2_IMPORT_PATH", path.resolve(qtPath, "qml"));
      if (requiresParallelDesktop) {
        const hostPrefix = await fs.promises
          .readFile(path.join(qtPath, "bin", "target_qt.conf"), "utf8")
          .then((data) => data.match(/^HostPrefix=(.*)$/m)?.[1].trim() ?? "")
          .catch(() => "");
        if (hostPrefix) {
          core.exportVariable("QT_HOST_PATH", path.resolve(qtPath, "bin", hostPrefix));
        }
      }
      core.addPath(path.resolve(qtPath, "bin"));
    }
  }
};

void run()
  .catch((err) => {
    if (err instanceof Error) {
      core.setFailed(err);
    } else {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      core.setFailed(`unknown error: ${err}`);
    }
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });
