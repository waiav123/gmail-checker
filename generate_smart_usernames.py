"""
生成更可能可用的 Gmail 用户名测试集
策略：随机 8 位字母数字 > 长数字 > 辅音+数字
"""
import random
import string

def generate(output_file="smart_usernames.txt", count=50000):
    usernames = set()
    
    # 策略 1：随机 8 位字母数字（最可能可用）- 60%
    target1 = int(count * 0.6)
    while len(usernames) < target1:
        s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        if s[0].isalpha():  # Gmail 要求字母开头
            usernames.add(s)
    
    # 策略 2：10-12 位纯数字 - 20%
    target2 = target1 + int(count * 0.2)
    while len(usernames) < target2:
        length = random.randint(10, 12)
        s = ''.join(random.choices(string.digits, k=length))
        usernames.add(s)
    
    # 策略 3：辅音组合 + 4 位数字 - 20%
    consonants = 'bcdfghjklmnpqrstvwxyz'
    while len(usernames) < count:
        prefix = ''.join(random.choices(consonants, k=random.randint(4, 6)))
        suffix = ''.join(random.choices(string.digits, k=4))
        usernames.add(prefix + suffix)
    
    usernames = list(usernames)[:count]
    random.shuffle(usernames)
    
    with open(output_file, "w") as f:
        f.write('\n'.join(usernames))
    
    print(f"生成 {len(usernames)} 个智能用户名 -> {output_file}")
    print(f"  字母数字 8 位: ~{target1}")
    print(f"  长数字 10-12 位: ~{int(count * 0.2)}")
    print(f"  辅音+数字: ~{int(count * 0.2)}")

if __name__ == "__main__":
    generate()
