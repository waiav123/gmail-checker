"""
生成6位纯数字组合，所有不重复号码
"""

def generate_numbers(output_file="all_numbers.txt"):
    """生成所有6位数字组合并写入文件"""
    print("开始生成6位纯数字组合...")
    
    count = 0
    with open(output_file, "w", encoding="utf-8") as f:
        for i in range(10**6):  # 6位数字最大值+1
            f.write(f"{i:06d}\n")
            count += 1
    
    print(f"完成！共生成 {count:,} 个不重复号码")
    print(f"已保存到 {output_file}")

if __name__ == "__main__":
    generate_numbers()
