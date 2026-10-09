$root = 'C:\Users\Asus\Documents\GitHub\.ThisCrowd'
Write-Output '=== MotionDiv references ==='
Get-ChildItem -Path (Join-Path $root 'packages\client') -Recurse -Include '*.tsx','*.ts' | Where-Object { $_.FullName -notmatch 'node_modules|dist' } | Select-String -Pattern 'MotionDiv' | ForEach-Object { ('{0}:{1}: {2}' -f $_.Filename, $_.LineNumber, $_.Line.Trim()) }
Write-Output '=== motion import still used in RightSidebar? ==='
Select-String -Path (Join-Path $root 'packages\client\components\workspace\RightSidebar.tsx') -Pattern 'motion\.' | Select-Object -First 5 | ForEach-Object { ('{0}: {1}' -f $_.LineNumber, $_.Line.Trim()) }
