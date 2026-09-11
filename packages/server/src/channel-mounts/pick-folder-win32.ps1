param(
    [string]$Title = "Select Repository Root",
    [string]$InitialPath = ""
)

$code = @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
class FileOpenDialogRCW {}

[ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes();
    void SetFileTypeIndex();
    void GetFileTypeIndex();
    void Advise();
    void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IntPtr psi);
    void SetFolder(IntPtr psi);
    void GetFolder(out IntPtr ppsi);
    void GetCurrentSelection(out IntPtr ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IntPtr ppsi);
    void AddPlace(IntPtr psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
    void BindToHandler();
    void GetParent();
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes();
    void Compare();
}

public class NativeFolderPicker {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        out IShellItem ppv);

    public static string Show(string title, string initialPath) {
        var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
        // FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40)
        dialog.SetOptions(0x20 | 0x40);
        if (!string.IsNullOrEmpty(title)) {
            dialog.SetTitle(title);
        }
        dialog.SetOkButtonLabel("Select Folder");
        if (!string.IsNullOrEmpty(initialPath)) {
            try {
                Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                IShellItem folder;
                SHCreateItemFromParsingName(initialPath, IntPtr.Zero, iid, out folder);
                if (folder != null) {
                    IntPtr pUnknown = Marshal.GetIUnknownForObject(folder);
                    dialog.SetFolder(pUnknown);
                }
            } catch {}
        }
        IntPtr parent = GetForegroundWindow();
        int hr = dialog.Show(parent);
        if (hr == 0) {
            IntPtr ppsi;
            dialog.GetResult(out ppsi);
            var item = (IShellItem)Marshal.GetObjectForIUnknown(ppsi);
            string name;
            item.GetDisplayName(0x80028000, out name); // SIGDN_FILESYSPATH
            return name;
        }
        return "";
    }
}
"@

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
    $result = [NativeFolderPicker]::Show($Title, $InitialPath)
    Write-Output $result
} catch {
    # Fallback to FolderBrowserDialog if COM fails
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.FolderBrowserDialog
    $f.Description = $Title
    $f.ShowNewFolderButton = $true
    if ($InitialPath -ne '' -and (Test-Path -LiteralPath $InitialPath)) {
        $f.SelectedPath = $InitialPath
    }
    if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $f.SelectedPath
    } else {
        Write-Output ""
    }
}
