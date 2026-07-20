import sharp from "sharp";

const [, , inputPath, outputPath, left, top, cropWidth, cropHeight, outWidth, outHeight] =
  process.argv;

await sharp(inputPath)
  .extract({
    left: Number(left),
    top: Number(top),
    width: Number(cropWidth),
    height: Number(cropHeight),
  })
  .resize(Number(outWidth), Number(outHeight), { fit: "fill" })
  .flatten({ background: "#ffffff" })
  .png()
  .toFile(outputPath);

console.log(`written: ${outputPath}`);
