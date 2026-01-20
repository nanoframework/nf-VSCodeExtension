// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Xml.Serialization;

namespace nanoFramework.Tools.DebugBridge.Symbols;

/// <summary>
/// Root element of the .pdbx file format.
/// The .pdbx file is an XML-based symbol file generated during nanoFramework compilation.
/// </summary>
[XmlRoot("PdbxFile")]
public class PdbxFile
{
    [XmlElement("Assembly")]
    public PdbxAssembly? Assembly { get; set; }

    /// <summary>
    /// Full path to the .pdbx file
    /// </summary>
    [XmlIgnore]
    public string? PdbxPath { get; set; }

    /// <summary>
    /// Initialize cross-references between elements after deserialization
    /// </summary>
    public void Initialize()
    {
        if (Assembly?.Classes == null) return;

        foreach (var cls in Assembly.Classes)
        {
            cls.Assembly = Assembly;

            if (cls.Methods != null)
            {
                foreach (var method in cls.Methods)
                {
                    method.Class = cls;
                }
            }

            if (cls.Fields != null)
            {
                foreach (var field in cls.Fields)
                {
                    field.Class = cls;
                }
            }
        }
    }
}

/// <summary>
/// Represents an assembly in the .pdbx file
/// </summary>
public class PdbxAssembly
{
    [XmlElement("FileName")]
    public string? FileName { get; set; }

    [XmlElement("Token")]
    public PdbxToken? Token { get; set; }

    [XmlElement("Version")]
    public PdbxVersion? Version { get; set; }

    [XmlArray("Classes")]
    [XmlArrayItem("Class")]
    public PdbxClass[]? Classes { get; set; }
}

/// <summary>
/// Assembly version information
/// </summary>
public class PdbxVersion
{
    [XmlElement("Major")]
    public int Major { get; set; }

    [XmlElement("Minor")]
    public int Minor { get; set; }

    [XmlElement("Build")]
    public int Build { get; set; }

    [XmlElement("Revision")]
    public int Revision { get; set; }

    public override string ToString() => $"{Major}.{Minor}.{Build}.{Revision}";
}

/// <summary>
/// Represents a class in the assembly
/// </summary>
public class PdbxClass
{
    [XmlElement("Name")]
    public string? Name { get; set; }

    [XmlElement("Token")]
    public PdbxToken? Token { get; set; }

    [XmlArray("Fields")]
    [XmlArrayItem("Field")]
    public PdbxField[]? Fields { get; set; }

    [XmlArray("Methods")]
    [XmlArrayItem("Method")]
    public PdbxMethod[]? Methods { get; set; }

    /// <summary>
    /// Back-reference to the parent assembly
    /// </summary>
    [XmlIgnore]
    public PdbxAssembly? Assembly { get; set; }
}

/// <summary>
/// Represents a field in a class
/// </summary>
public class PdbxField
{
    [XmlElement("Name")]
    public string? Name { get; set; }

    [XmlElement("Token")]
    public PdbxToken? Token { get; set; }

    /// <summary>
    /// Back-reference to the parent class
    /// </summary>
    [XmlIgnore]
    public PdbxClass? Class { get; set; }
}

/// <summary>
/// Represents a method in a class
/// </summary>
public class PdbxMethod
{
    [XmlElement("Name")]
    public string? Name { get; set; }

    [XmlElement("Token")]
    public PdbxToken? Token { get; set; }

    [XmlElement("HasByteCode")]
    public bool HasByteCode { get; set; } = true;

    [XmlArray("ILMap")]
    [XmlArrayItem("IL")]
    public PdbxIL[]? ILMap { get; set; }

    /// <summary>
    /// Back-reference to the parent class
    /// </summary>
    [XmlIgnore]
    public PdbxClass? Class { get; set; }

    /// <summary>
    /// Get the nanoFramework IL offset from a CLR IL offset
    /// </summary>
    public uint GetNanoILFromCLRIL(uint clrIL)
    {
        if (ILMap == null || ILMap.Length == 0)
        {
            return clrIL;
        }

        // Special case for end of function
        if (clrIL == uint.MaxValue)
        {
            return uint.MaxValue;
        }

        // Binary search for the IL mapping
        int index = Array.BinarySearch(ILMap, new PdbxIL { CLR = clrIL }, new ILComparerCLR());

        if (index >= 0)
        {
            // Exact match
            return ILMap[index].NanoCLR;
        }

        // Get insertion point
        index = ~index;

        if (index == 0)
        {
            // Before IL divergence
            return clrIL;
        }

        // Interpolate between mappings
        index--;
        var il = ILMap[index];
        return clrIL - il.CLR + il.NanoCLR;
    }

    /// <summary>
    /// Get the CLR IL offset from a nanoFramework IL offset
    /// </summary>
    public uint GetCLRILFromNanoIL(uint nanoIL)
    {
        if (ILMap == null || ILMap.Length == 0)
        {
            return nanoIL;
        }

        // Special case for end of function
        if (nanoIL == uint.MaxValue)
        {
            return uint.MaxValue;
        }

        // Binary search for the IL mapping
        int index = Array.BinarySearch(ILMap, new PdbxIL { NanoCLR = nanoIL }, new ILComparerNano());

        if (index >= 0)
        {
            // Exact match
            return ILMap[index].CLR;
        }

        // Get insertion point
        index = ~index;

        if (index == 0)
        {
            // Before IL divergence
            return nanoIL;
        }

        // Interpolate between mappings
        index--;
        var il = ILMap[index];
        return nanoIL - il.NanoCLR + il.CLR;
    }

    private class ILComparerCLR : IComparer<PdbxIL>
    {
        public int Compare(PdbxIL? x, PdbxIL? y)
        {
            if (x == null && y == null) return 0;
            if (x == null) return -1;
            if (y == null) return 1;
            return x.CLR.CompareTo(y.CLR);
        }
    }

    private class ILComparerNano : IComparer<PdbxIL>
    {
        public int Compare(PdbxIL? x, PdbxIL? y)
        {
            if (x == null && y == null) return 0;
            if (x == null) return -1;
            if (y == null) return 1;
            return x.NanoCLR.CompareTo(y.NanoCLR);
        }
    }
}

/// <summary>
/// Token mapping between CLR and nanoFramework
/// </summary>
public class PdbxToken
{
    private uint _clr;
    private uint _nanoCLR;

    /// <summary>
    /// CLR metadata token
    /// </summary>
    [XmlIgnore]
    public uint CLR
    {
        get => _clr;
        set => _clr = value;
    }

    /// <summary>
    /// nanoFramework token
    /// </summary>
    [XmlIgnore]
    public uint NanoCLR
    {
        get => _nanoCLR;
        set => _nanoCLR = value;
    }

    /// <summary>
    /// CLR token as hex string for XML serialization
    /// </summary>
    [XmlElement("CLR")]
    public string CLR_String
    {
        get => "0x" + _clr.ToString("X");
        set => _clr = ParseHex(value);
    }

    /// <summary>
    /// nanoFramework token as hex string for XML serialization
    /// </summary>
    [XmlElement("nanoCLR")]
    public string NanoCLR_String
    {
        get => "0x" + _nanoCLR.ToString("X");
        set => _nanoCLR = ParseHex(value);
    }

    private static uint ParseHex(string s)
    {
        s = s.Trim();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            s = s.Substring(2);
        }
        return uint.Parse(s, System.Globalization.NumberStyles.HexNumber);
    }
}

/// <summary>
/// IL offset mapping between CLR and nanoFramework
/// </summary>
public class PdbxIL
{
    private uint _clr;
    private uint _nanoCLR;

    /// <summary>
    /// CLR IL offset
    /// </summary>
    [XmlIgnore]
    public uint CLR
    {
        get => _clr;
        set => _clr = value;
    }

    /// <summary>
    /// nanoFramework IL offset
    /// </summary>
    [XmlIgnore]
    public uint NanoCLR
    {
        get => _nanoCLR;
        set => _nanoCLR = value;
    }

    /// <summary>
    /// CLR IL offset as hex string for XML serialization
    /// </summary>
    [XmlElement("CLR")]
    public string CLR_String
    {
        get => "0x" + _clr.ToString("X");
        set => _clr = ParseHex(value);
    }

    /// <summary>
    /// nanoFramework IL offset as hex string for XML serialization
    /// </summary>
    [XmlElement("nanoCLR")]
    public string NanoCLR_String
    {
        get => "0x" + _nanoCLR.ToString("X");
        set => _nanoCLR = ParseHex(value);
    }

    private static uint ParseHex(string s)
    {
        s = s.Trim();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            s = s.Substring(2);
        }
        return uint.Parse(s, System.Globalization.NumberStyles.HexNumber);
    }
}
