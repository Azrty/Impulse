$ErrorActionPreference = 'Stop'

function Await-WinRt($Operation, [Type] $ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

function Write-State([string] $Value) {
    [Console]::Out.WriteLine($Value)
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    $manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $last = ''
    $lastWrittenAt = [DateTime]::MinValue

    while ($true) {
        try {
            $session = $manager.GetSessions() |
                Where-Object { $_.SourceAppUserModelId -match '(?i)spotify' } |
                Select-Object -First 1
            $next = 'NOT_FOUND'
            if ($null -ne $session) {
                $playback = $session.GetPlaybackInfo()
                if ($playback.PlaybackStatus.ToString() -eq 'Playing') {
                    $properties = Await-WinRt ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                    $title = [string]$properties.Title
                    $artist = [string]$properties.Artist
                    if (-not [string]::IsNullOrWhiteSpace($title) -and -not [string]::IsNullOrWhiteSpace($artist)) {
                        $title64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($title))
                        $artist64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($artist))
                        $artwork64 = ''
                        if ($null -ne $properties.Thumbnail -and $properties.Thumbnail.Size -gt 0 -and $properties.Thumbnail.Size -le 2097152) {
                            $source = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($properties.Thumbnail)
                            $memory = New-Object System.IO.MemoryStream
                            try {
                                $source.CopyTo($memory)
                                if ($memory.Length -le 2097152) {
                                    $artwork64 = [Convert]::ToBase64String($memory.ToArray())
                                }
                            } finally {
                                $memory.Dispose()
                                $source.Dispose()
                            }
                        }
                        $next = "MUSIC`t$title64`t$artist64`t$artwork64"
                    } else {
                        $next = 'STOPPED'
                    }
                } else {
                    $next = 'STOPPED'
                }
            }
            $musicKeepalive = $next.StartsWith('MUSIC') -and ([DateTime]::UtcNow - $lastWrittenAt).TotalSeconds -ge 10
            if ($next -ne $last -or $musicKeepalive) {
                Write-State $next
                $last = $next
                $lastWrittenAt = [DateTime]::UtcNow
            }
        } catch {
            Write-State ("ERROR`t" + $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' '))
        }
        Start-Sleep -Seconds 2
    }
} catch {
    Write-State ("ERROR`t" + $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' '))
    exit 1
}
