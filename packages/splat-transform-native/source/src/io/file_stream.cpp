#include "file_stream.h"
#include <algorithm>
#include <boost/asio/buffer.hpp>
#include <boost/asio/io_context.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/thread_pool.hpp>
#include <cstdint>
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
                this->context = std::make_unique<boost::asio::io_context>();
                this->native = std::make_unique<boost::asio::random_access_file>(*this->context);
#if defined(_WIN32)
                // Asio's path overload is narrow; preserve filesystem::path's
                // Unicode semantics when opening Windows handles.
                HANDLE handle = CreateFileW(
                    path.c_str(), mode == Access::Read ? GENERIC_READ : GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                    mode == Access::Read ? OPEN_EXISTING : CREATE_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED | FILE_FLAG_SEQUENTIAL_SCAN, nullptr
                );
                if (handle == INVALID_HANDLE_VALUE) {
                    const auto error = GetLastError();
                    throw std::system_error(
                        static_cast<int32_t>(error), std::system_category(),
                        "Cannot open input/output file: " + path.string()
                    );
                }
                boost::system::error_code error;
                this->native->assign(handle, error);
                if (error) {
                    CloseHandle(handle);
                    throw boost::system::system_error(error);
                }
#else
                this->native->open(
                    path.string(), mode == Access::Read
                                       ? boost::asio::file_base::read_only
                                       : boost::asio::file_base::write_only | boost::asio::file_base::create |
                                             boost::asio::file_base::truncate
                );
#endif
                const auto size = this->native->size();
                if (size > std::numeric_limits<size_t>::max()) {
                    throw std::runtime_error("Invalid input length");
                }
                this->length = static_cast<size_t>(size);
                return;
            } catch (const boost::system::system_error&) {
                // io_uring may be disabled by the kernel or sandbox even when
                // its headers/libraries are available at build time.
                this->native.reset();
                this->context.reset();
            }
        }
#endif
        this->fallback.open(
            path, std::ios::binary | (mode == Access::Read ? std::ios::in : std::ios::out | std::ios::trunc)
        );
        if (!this->fallback) {
            throw std::runtime_error("Cannot open input/output file: " + path.string());
        }
        if (mode == Access::Read) {
            const auto size = std::filesystem::file_size(path);
            if (size > std::numeric_limits<size_t>::max()) {
                throw std::runtime_error("Invalid input length");
            }
            this->length = static_cast<size_t>(size);
        }
    }
};
FileStream::FileStream(const std::filesystem::path& path, Access access, Backend backend)
    : impl_(std::make_unique<Impl>(path, access, backend)) {}
FileStream::~FileStream() = default;
size_t FileStream::size() const { return this->impl_->length; }
bool FileStream::uses_native_backend() const noexcept {
#if defined(BOOST_ASIO_HAS_FILE)
    return static_cast<bool>(this->impl_->native);
#else
    return false;
#endif
}
size_t FileStream::read(std::span<std::byte> target) {
    if (this->impl_->access != Access::Read) {
        throw std::runtime_error("File is not readable");
    }
    if (target.empty() || this->impl_->offset == this->impl_->length) {
        return 0;
    }
    target = target.first(std::min(target.size(), this->impl_->length - this->impl_->offset));
    size_t count = 0;
#if defined(BOOST_ASIO_HAS_FILE)
    if (this->impl_->native) {
        boost::system::error_code error;
        count = boost::asio::read_at(
            *this->impl_->native, this->impl_->offset, boost::asio::buffer(target.data(), target.size()), error
        );
        if (error && error != boost::asio::error::eof) {
            throw boost::system::system_error(error);
        }
    } else
#endif
    {
        count = blocking_file_operation([&] {
            this->impl_->fallback.read(
                reinterpret_cast<char*>(target.data()), static_cast<std::streamsize>(target.size())
            );
            if (this->impl_->fallback.bad() || (this->impl_->fallback.fail() && !this->impl_->fallback.eof())) {
                throw std::runtime_error("Cannot read input file");
            }
            return static_cast<size_t>(this->impl_->fallback.gcount());
        });
    }
    this->impl_->offset += count;
    return count;
}
void FileStream::write(std::span<const std::byte> bytes) {
    if (this->impl_->access != Access::Write) {
        throw std::runtime_error("File is not writable");
    }
    if (bytes.empty()) {
        return;
    }
#if defined(BOOST_ASIO_HAS_FILE)
    if (this->impl_->native) {
        boost::asio::write_at(
            *this->impl_->native, this->impl_->offset, boost::asio::buffer(bytes.data(), bytes.size())
        );
    } else
#endif
    {
        blocking_file_operation([&] {
            this->impl_->fallback.write(
                reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size())
            );
            if (!this->impl_->fallback) {
                throw std::runtime_error("Cannot write output file");
            }
        });
    }
    this->impl_->offset += bytes.size();
    this->impl_->length = std::max(this->impl_->length, this->impl_->offset);
}
void FileStream::seek(size_t offset) {
    if (this->impl_->access != Access::Write) {
        throw std::runtime_error("File is not writable");
    }
#if defined(BOOST_ASIO_HAS_FILE)
    if (!this->impl_->native)
#endif
    {
        blocking_file_operation([&] {
            this->impl_->fallback.seekp(static_cast<std::streamoff>(offset));
            if (!this->impl_->fallback) {
                throw std::runtime_error("Cannot seek output file");
            }
        });
    }
    this->impl_->offset = offset;
}
void FileStream::close() {
#if defined(BOOST_ASIO_HAS_FILE)
    if (this->impl_->native) {
        this->impl_->native->close();
        return;
    }
#endif
    blocking_file_operation([&] {
        this->impl_->fallback.clear();
        this->impl_->fallback.close();
        if (this->impl_->fallback.fail()) {
            throw std::runtime_error("Cannot close input/output file");
        }
    });
}
} // namespace splat_transform::io
