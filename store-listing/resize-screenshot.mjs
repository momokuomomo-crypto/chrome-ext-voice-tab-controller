import sharp from "sharp";

const [, , inputPath, outputPath, widthArg, heightArg] = process.argv;
const width = Number(widthArg);
const height = Number(heightArg);

await sharp(inputPath)
  .resize(width, height, { fit: "fill" })
  .flatten({ background: "#ffffff" }) // アルファチャンネルを白背景で除去（24bit PNG化）
  .png()
  .toFile(outputPath);

console.log(`written: ${outputPath} (${width}x${height})`);
