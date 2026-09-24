// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Certificates;
using Azure.Security.KeyVault.Keys.Cryptography;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: VsixSignTool <manifest-path> <signature-path>");
    return 2;
}

string tenantId = GetRequiredEnvironmentVariable("AZURE_TENANT_ID");
string clientId = GetRequiredEnvironmentVariable("AZURE_CLIENT_ID");
string clientSecret = GetRequiredEnvironmentVariable("AZURE_CLIENT_SECRET");
string vaultUrl = GetRequiredEnvironmentVariable("AZURE_KEY_VAULT_URL");
string certificateName = GetRequiredEnvironmentVariable("AZURE_KEY_VAULT_CERTIFICATE");

TokenCredential credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
CertificateClient certificateClient = new(new Uri(vaultUrl), credential);
KeyVaultCertificateWithPolicy keyVaultCertificate = certificateClient.GetCertificate(certificateName);
X509Certificate2 certificate = X509CertificateLoader.LoadCertificate(keyVaultCertificate.Cer);

if (keyVaultCertificate.KeyId is null)
{
    throw new InvalidOperationException($"Certificate '{certificateName}' does not have an associated Key Vault key.");
}

// Bind SignedCms to the non-exportable private key held by Azure Key Vault.
CryptographyClient cryptographyClient = new(keyVaultCertificate.KeyId, credential);
using RSA publicKey = certificate.GetRSAPublicKey()
    ?? throw new InvalidOperationException($"Certificate '{certificateName}' is not an RSA certificate.");
using RSA signingKey = new KeyVaultRsa(cryptographyClient, publicKey.ExportParameters(false));

// VSCE publishes the CMS signature separately from the signature manifest.
ContentInfo content = new(File.ReadAllBytes(args[0]));
SignedCms signedCms = new(content, detached: true);
CmsSigner signer = new(SubjectIdentifierType.IssuerAndSerialNumber, certificate)
{
    DigestAlgorithm = new Oid("2.16.840.1.101.3.4.2.1"),
    IncludeOption = X509IncludeOption.EndCertOnly,
    PrivateKey = signingKey
};

signedCms.ComputeSignature(signer, silent: true);
File.WriteAllBytes(args[1], signedCms.Encode());
Console.WriteLine($"Signed VSIX manifest with Azure Key Vault certificate '{certificateName}'.");
return 0;

static string GetRequiredEnvironmentVariable(string name)
{
    string? value = Environment.GetEnvironmentVariable(name);
    return string.IsNullOrWhiteSpace(value)
        ? throw new InvalidOperationException($"Required environment variable '{name}' is not set.")
        : value;
}

/// <summary>
/// Provides an <see cref="RSA"/> implementation backed by an Azure Key Vault signing key.
/// </summary>
sealed class KeyVaultRsa(CryptographyClient client, RSAParameters publicParameters) : RSA
{
    /// <inheritdoc />
    public override byte[] Decrypt(byte[] data, RSAEncryptionPadding padding) =>
        throw new NotSupportedException();

    /// <inheritdoc />
    public override byte[] Encrypt(byte[] data, RSAEncryptionPadding padding) =>
        throw new NotSupportedException();

    /// <inheritdoc />
    public override RSAParameters ExportParameters(bool includePrivateParameters)
    {
        if (includePrivateParameters)
        {
            throw new CryptographicException("The Azure Key Vault private key cannot be exported.");
        }

        return publicParameters;
    }

    /// <inheritdoc />
    public override void ImportParameters(RSAParameters parameters) =>
        throw new NotSupportedException();

    /// <inheritdoc />
    public override byte[] SignHash(byte[] hash, HashAlgorithmName hashAlgorithm, RSASignaturePadding padding)
    {
        if (padding != RSASignaturePadding.Pkcs1)
        {
            throw new CryptographicException("Only PKCS#1 signatures are supported.");
        }

        SignatureAlgorithm algorithm = hashAlgorithm.Name switch
        {
            "SHA256" => new SignatureAlgorithm("RS256"),
            "SHA384" => new SignatureAlgorithm("RS384"),
            "SHA512" => new SignatureAlgorithm("RS512"),
            _ => throw new CryptographicException($"Unsupported hash algorithm: {hashAlgorithm.Name}")
        };

        return client.Sign(algorithm, hash).Signature;
    }

    /// <inheritdoc />
    public override bool VerifyHash(byte[] hash, byte[] signature, HashAlgorithmName hashAlgorithm, RSASignaturePadding padding)
    {
        using RSA publicKey = RSA.Create(publicParameters);
        return publicKey.VerifyHash(hash, signature, hashAlgorithm, padding);
    }
}