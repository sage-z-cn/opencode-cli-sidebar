const path = require("path");
const webpack = require("webpack");
const CopyPlugin = require("copy-webpack-plugin");

// Two stable tokens for the VS Code watch problemMatcher in tasks.json:
// beginsPattern on "watch build started", endsPattern on "extension bundle ready"
// so preLaunchTask waits only until dist/extension.js is written.
class ExtensionReadyPlugin {
  apply(compiler) {
    compiler.hooks.watchRun.tap("ExtensionReadyPlugin", () => {
      console.log("opencode-cli-sidebar: webpack watch build started");
    });
    compiler.hooks.done.tap("ExtensionReadyPlugin", () => {
      console.log("opencode-cli-sidebar: extension bundle ready");
    });
  }
}

const extensionConfig = {
  target: "node",
  mode: "none",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: {
    vscode: "commonjs vscode",
    "node-pty": "commonjs node-pty",
    // Optional native accelerators for `ws`; not installed on purpose.
    // Keeping the require() calls unresolved makes them throw at runtime so
    // ws's own try/catch falls back to its pure-JS implementations. (Do NOT
    // alias these to false: webpack 5 resolves that to an empty module, so
    // the require succeeds with `{}` and bufferUtil.unmask is undefined.)
    bufferutil: "commonjs bufferutil",
    "utf-8-validate": "commonjs utf-8-validate",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [
          /node_modules/,
          /example-projects/,
          /\.test\.ts$/,
          /src\/test\//,
          /src\/\__tests__\//,
        ],
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
      {
        test: /\.html$/,
        resourceQuery: /raw/,
        type: "asset/source",
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, "l10n").replace(/\\/g, "/"),
          to: path.resolve(__dirname, "dist/l10n"),
          noErrorOnMissing: true,
        },
      ],
    }),
    new ExtensionReadyPlugin(),
  ],
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log",
  },
};

const webviewConfig = {
  target: "web",
  mode: "none",
  entry: {
    main: "./src/webview/main.tsx",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: (pathData) => {
      if (pathData.chunk.name === "main") {
        return "webview.js";
      }
      return "[name].js";
    },
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
    fallback: {
      path: false,
      fs: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: [
          /node_modules/,
          /example-projects/,
          /\.test\.tsx?$/,
          /src\/test\//,
          /src\/\__tests__\//,
        ],
        use: [
          {
            loader: "esbuild-loader",
            options: {
              loader: "tsx",
              target: "es2020",
              // React uses the automatic JSX runtime, so no React import needed.
              jsx: "automatic",
            },
          },
        ],
      },
      {
        test: /\.html$/,
        resourceQuery: /raw/,
        type: "asset/source",
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
      {
        // xterm.css is imported from node_modules and ships plain CSS with
        // url() references; css-loader rewrites them to webpack assets.
        test: /\.(woff2?|ttf|eot|svg|png)$/,
        type: "asset/resource",
      },
    ],
  },
  plugins: [
    // React ships separate production/development entry points selected via
    // `process.env.NODE_ENV`. The webview bundle has no Node runtime, so an
    // un-substituted reference throws `process is not defined` before any of
    // our code runs. Defining it also drops React's dev-only code paths.
    //
    // Only this one expression is replaced on purpose. Substituting the whole
    // `process` object breaks defensive `typeof process === "object"` probes:
    // the object literal lands at statement position, where `{` parses as a
    // block and the following `:` is a syntax error.
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify("production"),
    }),
    new CopyPlugin({
      patterns: [
        {
          context: path.resolve(__dirname, "src/webview").replace(/\\/g, "/"),
          from: "*.css",
          to: path.resolve(__dirname, "dist"),
        },
        {
          context: path.resolve(__dirname, "src/webview").replace(/\\/g, "/"),
          from: "**/*.css",
          to: path.resolve(__dirname, "dist"),
        },
      ],
    }),
  ],
  devtool: "nosources-source-map",
  performance: { hints: false },
};

module.exports = [extensionConfig, webviewConfig];
