# Processo auxiliar do Soundboard (só Windows): escuta o Raw Input de todos os teclados,
# mesmo com o app em segundo plano, e escreve no stdout de qual teclado veio cada tecla:
#   R                                        pronto
#   D <handle> <caminho do dispositivo>\t<produto>   primeira tecla de cada teclado
#   K <handle> <scancode> <flags> <vkey>     cada tecla (flags do RAWKEYBOARD: 1 = soltou, 2 = E0)
# Só observa: a tecla continua chegando ao app em foco. Sai quando o Soundboard ($ParentPid) fecha.
param([int]$ParentPid)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class SoundboardRawKeyboard : NativeWindow
{
    const int WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIDI_DEVICENAME = 0x20000007;
    const uint RIM_TYPEKEYBOARD = 1;
    const uint RIDEV_INPUTSINK = 0x00000100;

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTHEADER { public uint Type; public uint Size; public IntPtr Device; public IntPtr WParam; }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWKEYBOARD { public ushort MakeCode; public ushort Flags; public ushort Reserved; public ushort VKey; public uint Message; public uint ExtraInformation; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr rawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, StringBuilder data, ref uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("hid.dll", CharSet = CharSet.Unicode)]
    static extern bool HidD_GetProductString(IntPtr device, StringBuilder buffer, uint bytes);

    readonly HashSet<IntPtr> known = new HashSet<IntPtr>();

    SoundboardRawKeyboard()
    {
        // janela invisível só para receber WM_INPUT; INPUTSINK = recebe mesmo sem foco
        CreateHandle(new CreateParams());
        var devices = new RAWINPUTDEVICE[1];
        devices[0].UsagePage = 0x01;
        devices[0].Usage = 0x06; // teclado
        devices[0].Flags = RIDEV_INPUTSINK;
        devices[0].Target = Handle;
        if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
            throw new Exception("RegisterRawInputDevices falhou: " + Marshal.GetLastWin32Error());
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_INPUT) Read(m.LParam);
        base.WndProc(ref m);
    }

    void Read(IntPtr rawInput)
    {
        uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
        uint size = 0;
        GetRawInputData(rawInput, RID_INPUT, IntPtr.Zero, ref size, headerSize);
        if (size == 0) return;
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(rawInput, RID_INPUT, buffer, ref size, headerSize) != size) return;
            var header = (RAWINPUTHEADER)Marshal.PtrToStructure(buffer, typeof(RAWINPUTHEADER));
            // Device zero é tecla simulada por software (SendInput): não tem teclado de origem
            if (header.Type != RIM_TYPEKEYBOARD || header.Device == IntPtr.Zero) return;
            var kb = (RAWKEYBOARD)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + headerSize), typeof(RAWKEYBOARD));
            string id = header.Device.ToInt64().ToString("x");
            if (known.Add(header.Device)) Console.WriteLine("D " + id + " " + DeviceName(header.Device));
            Console.WriteLine("K " + id + " " + kb.MakeCode + " " + kb.Flags + " " + kb.VKey);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    static string DeviceName(IntPtr device)
    {
        uint size = 0;
        GetRawInputDeviceInfo(device, RIDI_DEVICENAME, null, ref size);
        var name = new StringBuilder((int)size + 1);
        GetRawInputDeviceInfo(device, RIDI_DEVICENAME, name, ref size);
        string product = "";
        // acesso 0 basta para ler o nome do produto (o Windows não deixa abrir teclados para leitura)
        IntPtr file = CreateFile(name.ToString(), 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (file != new IntPtr(-1))
        {
            var buffer = new StringBuilder(128);
            if (HidD_GetProductString(file, buffer, 256)) product = buffer.ToString();
            CloseHandle(file);
        }
        return name.ToString() + "\t" + product.Replace("\t", " ").Trim();
    }

    public static void Run(int parentPid)
    {
        var window = new SoundboardRawKeyboard();
        var watchdog = new Thread(delegate ()
        {
            try { Process.GetProcessById(parentPid).WaitForExit(); } catch { }
            Environment.Exit(0);
        });
        watchdog.IsBackground = true;
        watchdog.Start();
        Console.WriteLine("R");
        Application.Run();
        GC.KeepAlive(window);
    }
}
'@

[SoundboardRawKeyboard]::Run($ParentPid)
