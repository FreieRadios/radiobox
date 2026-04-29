r = regexp(flags=["g","i"], "(\\d{8})-(\\d{6})")

# Memo: bereits abgespielte Dateien mit Sende-Epoch-Sekunden,
# damit ein Match im Toleranzfenster nur einmal feuert.
played_files = ref([])

def already_played(filename) =
  list.exists(fun (entry) -> fst(entry) == filename, played_files())
end

def remember_played(filename, target_epoch) =
  played_files := [(filename, target_epoch), ...played_files()]
end

# Memo aufräumen: Einträge älter als 300s entfernen.
def cleanup_played() =
  now_t = time()
  played_files := list.filter(
    fun (entry) -> (now_t - snd(entry)) < 300.,
    played_files()
  )
end

def match_filename(filename) =
  m = r.exec(filename)
  if m != [] then
    # Extract date and time from filename (format: YYYYMMDD-HHMMSS)
    date_str = m[1]
    time_str = m[2]

    # Parse the filename datetime
    year = int_of_string(string.sub(date_str, start=0, length=4))
    month = int_of_string(string.sub(date_str, start=4, length=2))
    day = int_of_string(string.sub(date_str, start=6, length=2))
    hour = int_of_string(string.sub(time_str, start=0, length=2))
    minute = int_of_string(string.sub(time_str, start=2, length=2))
    second = int_of_string(string.sub(time_str, start=4, length=2))

    # Get current time components
    current_time = time.local()
    current_year = current_time.year
    current_month = current_time.month
    current_day = current_time.day
    current_hour = current_time.hour
    current_min = current_time.min
    current_sec = current_time.sec

    # Check if it's the right date
    if year == current_year and month == current_month and day == current_day then
      target_seconds = hour * 3600 + minute * 60 + second
      current_seconds = current_hour * 3600 + current_min * 60 + current_sec
      time_diff = abs(target_seconds - current_seconds)

      if time_diff <= repeats_tolerance then
        if not already_played(filename) then
          full_path = path.concat(repeats_dir, filename)

          if file.exists(full_path) then
            log("Match found! Playing file: #{filename}")
            current_meta_list = q.last_metadata() ?? []
            current_filename = current_meta_list["filename"] ?? ""

            # Only play if it's not the same file currently playing
            if current_filename != full_path then
              uri = "file://#{full_path}"
              play_request = request.create(uri)
              q.set_queue([play_request])
              q.skip()
              log(">>>>>>  Playing #{filename} now")
              remember_played(filename, time())
            end
          else
            log.important("File matched by pattern but not found on disk: #{full_path}")
          end
        end
      end
    end
  end
end

def scan_and_schedule() =
  cleanup_played()
  files = file.ls(repeats_dir)
  list.iter(match_filename, files)
  repeats_check_interval
end

thread.run.recurrent(delay=repeats_check_interval, scan_and_schedule)
