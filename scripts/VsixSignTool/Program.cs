// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Net.Http.Headers;
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
await AddTimestampAsync(signedCms);
File.WriteAllBytes(args[1], signedCms.Encode());
Console.WriteLine($"Signed VSIX manifest with Azure Key Vault certificate '{certificateName}'.");
return 0;

static async Task AddTimestampAsync(SignedCms signedCms)
{
    const string TimestampAuthorityUrl = "http://timestamp.digicert.com";
    const string TimestampTokenOid = "1.2.840.113549.1.9.16.2.14";
    const string TimestampingEkuOid = "1.3.6.1.5.5.7.3.8";

    SignerInfo signerInfo = signedCms.SignerInfos[0];
    byte[] nonce = RandomNumberGenerator.GetBytes(16);
    Rfc3161TimestampRequest timestampRequest = Rfc3161TimestampRequest.CreateFromSignerInfo(
        signerInfo,
        HashAlgorithmName.SHA256,
        nonce: nonce,
        requestSignerCertificates: true);

    using HttpClient httpClient = new();
    using ByteArrayContent requestContent = new(timestampRequest.Encode());
    requestContent.Headers.ContentType = new MediaTypeHeaderValue("application/timestamp-query");
    using HttpResponseMessage response = await httpClient.PostAsync(TimestampAuthorityUrl, requestContent);
    response.EnsureSuccessStatusCode();

    byte[] responseBytes = await response.Content.ReadAsByteArrayAsync();
    Rfc3161TimestampToken timestampToken = timestampRequest.ProcessResponse(responseBytes, out int bytesConsumed);
    if (bytesConsumed != responseBytes.Length)
    {
        throw new CryptographicException("The timestamp authority response contains trailing data.");
    }

    if (!timestampToken.VerifySignatureForSignerInfo(signerInfo, out X509Certificate2? timestampCertificate))
    {
        throw new CryptographicException("The timestamp token signature is invalid.");
    }

    using (timestampCertificate)
    using (X509Chain chain = new())
    {
        chain.ChainPolicy.ExtraStore.AddRange(timestampToken.AsSignedCms().Certificates);
        chain.ChainPolicy.ApplicationPolicy.Add(new Oid(TimestampingEkuOid));
        chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
        chain.ChainPolicy.VerificationTime = timestampToken.TokenInfo.Timestamp.UtcDateTime;

        if (!chain.Build(timestampCertificate))
        {
            string errors = string.Join(", ", chain.ChainStatus.Select(status => status.StatusInformation.Trim()));
            throw new CryptographicException($"The timestamp certificate is not trusted: {errors}");
        }
    }

    signerInfo.AddUnsignedAttribute(new AsnEncodedData(
        new Oid(TimestampTokenOid),
        timestampToken.AsSignedCms().Encode()));
}

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