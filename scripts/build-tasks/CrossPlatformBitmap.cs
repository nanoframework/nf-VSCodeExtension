//
// Copyright (c) .NET Foundation and Contributors
// See LICENSE file in the project root for full license information.
//

using System;
using System.Buffers.Binary;
using System.IO;
using StbImageSharp;
using BitmapDescription = nanoFramework.Tools.ProcessResourceFiles.NanoResourceFile.CLR_GFX_BitmapDescription;

namespace nanoFramework.Tools
{
    internal static class CrossPlatformBitmap
    {
        internal static bool IsSupportedBitmap(byte[] data)
        {
            return TryGetBitmapType(data, out _);
        }

        internal static byte[] GenerateBitmapResourceData(byte[] data)
        {
            if (!TryGetBitmapType(data, out byte type))
            {
                throw new NotSupportedException("Bitmap format not supported.");
            }

            using (var input = new MemoryStream(data))
            {
                ImageInfo? info = ImageInfo.FromStream(input);
                if (!info.HasValue)
                {
                    throw new InvalidDataException("Cannot read bitmap dimensions.");
                }
                long height = type == BitmapDescription.c_TypeBitmap
                    ? Math.Abs((long)info.Value.Height)
                    : info.Value.Height;
                if (info.Value.Width <= 0 || height <= 0 ||
                    info.Value.Width > ushort.MaxValue || height > ushort.MaxValue)
                {
                    throw new ArgumentException("bitmap dimensions out of range");
                }
                if (type == BitmapDescription.c_TypeBitmap)
                {
                    ValidateBmpPixelData(data, info.Value.Width, height);
                }
            }

            ImageResult image = ImageResult.FromMemory(data, ColorComponents.RedGreenBlueAlpha);
            byte[] payload = type == BitmapDescription.c_TypeBitmap ? ConvertToRgb565(image) : data;
            var description = new BitmapDescription(
                (ushort)image.Width, (ushort)image.Height, 0,
                type == BitmapDescription.c_TypeBitmap ? (byte)16 : (byte)1, type);

            using (var output = new MemoryStream())
            using (var writer = new BinaryWriter(output))
            {
                description.Serialize(writer);
                writer.Write(payload);
                return output.ToArray();
            }
        }

        private static void ValidateBmpPixelData(byte[] data, int width, long height)
        {
            uint headerSize = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(14, 4));
            int bitDepthOffset = headerSize == 12 ? 24 : 28;
            long headerEnd = 14L + headerSize;
            if (data.Length < bitDepthOffset + 2 || data.LongLength < headerEnd)
            {
                throw new InvalidDataException("BMP header is truncated.");
            }

            uint pixelOffset = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(10, 4));
            ushort bitsPerPixel = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(bitDepthOffset, 2));
            // BMP scanlines are padded to a four-byte boundary, regardless of their orientation.
            long rowStride = ((long)width * bitsPerPixel + 31) / 32 * 4;
            if (pixelOffset < headerEnd || pixelOffset + rowStride * height > data.LongLength)
            {
                throw new InvalidDataException("BMP pixel data is truncated or has an invalid offset.");
            }
        }

        private static bool TryGetBitmapType(byte[] data, out byte type)
        {
            type = 0;
            if (data == null)
            {
                return false;
            }
            if (data.Length >= 2 && data[0] == 0x42 && data[1] == 0x4D)
            {
                type = BitmapDescription.c_TypeBitmap;
                return true;
            }
            if (data.Length >= 6 && data[0] == 'G' && data[1] == 'I' && data[2] == 'F' &&
                data[3] == '8' && (data[4] == '7' || data[4] == '9') && data[5] == 'a')
            {
                type = BitmapDescription.c_TypeGif;
                return true;
            }
            if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
            {
                type = BitmapDescription.c_TypeJpeg;
                return true;
            }
            return false;
        }

        private static byte[] ConvertToRgb565(ImageResult image)
        {
            byte[] result = new byte[checked(image.Width * image.Height * 2)];
            for (int source = 0, target = 0; target < result.Length; source += 4, target += 2)
            {
                // Preserve the upstream task's RGB565 quantization and top-down pixel order.
                int red = Math.Min(31, (image.Data[source] + 4) >> 3);
                int green = image.Data[source + 1] >> 2;
                int blue = Math.Min(31, (image.Data[source + 2] + 4) >> 3);
                ushort pixel = (ushort)((red << 11) | (green << 5) | blue);
                result[target] = (byte)pixel;
                result[target + 1] = (byte)(pixel >> 8);
            }
            return result;
        }
    }
}
