#include "file_stream.h"
#include <algorithm>
#include <boost/asio/buffer.hpp>
#include <boost/asio/io_context.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/thread_pool.hpp>
#include <fstream>
#include <future>
#include <io/file.h>
#include <limits>
#include <system_error>
#if defined(BOOST_ASIO_HAS_FILE)
#include <boost/asio/random_access_file.hpp>
#include <boost/asio/read_at.hpp>
#include <boost/asio/write_at.hpp>
#endif
#if defined(_WIN32)
#include <Windows.h>
#endif

namespace splat_transform::io {
namespace {
boost::asio::thread_pool& file_executor() {
    static boost::asio::thread_pool pool(2);
    return pool;
}
template<typename F>
auto blocking_file_operation(F&& operation) {
    std::packaged_task<std::invoke_result_t<F>()> task(std::forward<F>(operation));
    auto result = task.get_future();
    boost::asio::post(file_executor(), std::move(task));
    return result.get();
}
} // namespace
struct FileStream::Impl {
    Access access;
    size_t length = 0, offset = 0;
    std::fstream fallback;
#if defined(BOOST_ASIO_HAS_FILE)
    std::unique_ptr<boost::asio::io_context> context;
    std::unique_ptr<boost::asio::random_access_file> native;
#endif
    Impl(const std::filesystem::path& path, Access mode, Backend backend) : access(mode) {
#if defined(BOOST_ASIO_HAS_FILE)
        if (backend == Backend::Automatic) {
            try {
                context = std::make_unique<boost::asio::io_context>();
                native = std::make_unique<boost::asio::random_access_file>(*context);
#if defined(_WIN32)
                // Asio's path overload is narrow; preserve filesystem::path's
                // Unicode semantics when opening Windows handles.
                HANDLE handle = CreateFileW(path.c_str(), mode == Access::Read ? GENERIC_READ : GENERIC_WRITE,
                    FILE_SHARE_READ, nullptr, mode == Access::Read ? OPEN_EXISTING : CREATE_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
                if (handle == INVALID_HANDLE_VALUE) {
                    const auto error = GetLastError();
                    throw std::system_error(int(error), std::system_category(), "Cannot open input/output file: " + path_utf8(path));
                }
                boost::system::error_code error;
                native->assign(handle, error);
                if (error) {
                    CloseHandle(handle);
                    throw boost::system::system_error(error);
                }
#else
                native->open(path.string(), mode == Access::Read ? boost::asio::file_base::read_only : boost::asio::file_base::write_only | boost::asio::file_base::create | boost::asio::file_base::truncate);
#endif
                const auto size = native->size();
                if (size > std::numeric_limits<size_t>::max()) {
                    throw std::runtime_error("Invalid input length");
                }
                length = static_cast<size_t>(size);
                return;
            } catch (const boost::system::system_error&) {
                // io_uring may be disabled by the kernel or sandbox even when
                // its headers/libraries are available at build time.
                native.reset();
                context.reset();
            }
        }
#endif
        fallback.open(path, std::ios::binary | (mode == Access::Read ? std::ios::in : std::ios::out | std::ios::trunc));
        if (!fallback) {
            throw std::runtime_error("Cannot open input/output file: " + path_utf8(path));
        }
        if (mode == Access::Read) {
            const auto size = std::filesystem::file_size(path);
            if (size > std::numeric_limits<size_t>::max()) {
                throw std::runtime_error("Invalid input length");
            }
            length = static_cast<size_t>(size);
        }
    }
};
FileStream::FileStream(const std::filesystem::path& path, Access access, Backend backend) : impl_(std::make_unique<Impl>(path, access, backend)) {}
FileStream::~FileStream() = default;
size_t FileStream::size() const { return impl_->length; }
bool FileStream::uses_native_backend() const noexcept {
#if defined(BOOST_ASIO_HAS_FILE)
    return static_cast<bool>(impl_->native);
#else
    return false;
#endif
}
size_t FileStream::read(std::span<uint8_t> target) {
    if (impl_->access != Access::Read) {
        throw std::runtime_error("File is not readable");
    }
    if (target.empty() || impl_->offset == impl_->length) {
        return 0;
    }
    target = target.first(std::min(target.size(), impl_->length - impl_->offset));
    size_t count = 0;
#if defined(BOOST_ASIO_HAS_FILE)
    if (impl_->native) {
        boost::system::error_code error;
        count = boost::asio::read_at(*impl_->native, impl_->offset, boost::asio::buffer(target.data(), target.size()), error);
        if (error && error != boost::asio::error::eof) {
            throw boost::system::system_error(error);
        }
    } else
#endif
    {
        count = blocking_file_operation([&] {
            impl_->fallback.read(reinterpret_cast<char*>(target.data()), static_cast<std::streamsize>(target.size()));
            if (impl_->fallback.bad() || (impl_->fallback.fail() && !impl_->fallback.eof())) {
                throw std::runtime_error("Cannot read input file");
            }
            return static_cast<size_t>(impl_->fallback.gcount());
        });
    }
    impl_->offset += count;
    return count;
}
void FileStream::write(std::span<const uint8_t> bytes) {
    if (impl_->access != Access::Write) {
        throw std::runtime_error("File is not writable");
    }
    if (bytes.empty()) {
        return;
    }
#if defined(BOOST_ASIO_HAS_FILE)
    if (impl_->native) {
        boost::asio::write_at(*impl_->native, impl_->offset, boost::asio::buffer(bytes.data(), bytes.size()));
    } else
#endif
    {
        blocking_file_operation([&] {
            impl_->fallback.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
            if (!impl_->fallback) {
                throw std::runtime_error("Cannot write output file");
            }
        });
    }
    impl_->offset += bytes.size();
    impl_->length = std::max(impl_->length, impl_->offset);
}
void FileStream::seek(size_t offset) {
    if (impl_->access != Access::Write) {
        throw std::runtime_error("File is not writable");
    }
#if defined(BOOST_ASIO_HAS_FILE)
    if (!impl_->native)
#endif
    {
        blocking_file_operation([&] {
            impl_->fallback.seekp(static_cast<std::streamoff>(offset));
            if (!impl_->fallback) {
                throw std::runtime_error("Cannot seek output file");
            }
        });
    }
    impl_->offset = offset;
}
void FileStream::close() {
#if defined(BOOST_ASIO_HAS_FILE)
    if (impl_->native) {
        impl_->native->close();
        return;
    }
#endif
    blocking_file_operation([&] {
        impl_->fallback.clear();
        impl_->fallback.close();
        if (impl_->fallback.fail()) {
            throw std::runtime_error("Cannot close input/output file");
        }
    });
}
} // namespace splat_transform::io
