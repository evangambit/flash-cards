const path = require('path');

module.exports = {
  target: "web", // Ensures Webpack is targeting a web environment
  mode: "development",
  devtool: "source-map",
  resolve: {
    extensions: [".ts", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.html$/i,
        loader: "html-loader",
      },
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  entry: ['./frontend/main.ts'],
  output: {
    filename: 'main.js',
    path: path.resolve(__dirname, 'dist'),
  },
};
